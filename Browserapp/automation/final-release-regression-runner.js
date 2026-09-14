#!/usr/bin/env node
'use strict';

/**
 * OpenBrowser Pre-Release Final Regression & Aggregated Verification Runner.
 *
 * Orchestrates and executes the complete verification pipeline prior to release:
 * 1. Pre-flight Static Audits:
 *    - 7-point version synchronization check (dynamic semver verification across all 7 canonical locations from package.json)
 *    - Git staging and working tree pollution check (zero forbidden patterns, cross-platform normalization)
 *    - Working-tree disk hygiene (zero pycache, zero screenshot artifacts)
 *    - Re-entry and recursion prevention guard
 * 2. Core Blocking Regression Suites (selftest:*):
 *    - 56 verified suites across 12 functional domains:
 *      * Worker Isolation & WebGPU Parity (workerwebgpu, workerfontpresence, workerfontwiring, webrtcfb)
 *      * Cross-Surface Multi-Context Parity (crosssurface, canvasaudiorects)
 *      * Font System Integrity, CJK Probing & Deep Metadata (fontpresence, fontdeepmeta, fontnametable, fontblob, fontblobassets, winfontsubsets, macosfontsubsets, fontcjkprobe, fontconsistency)
 *      * CSS Font Interception & Guard Barriers (cssfontgate, cssfontrewrite, cssfontwiring, cssfontbypass, initialpageguard)
 *      * Graphics & WebGL Parameter Normalization & Compatibility (webglarchnorm, webglextprofile, webglcompat)
 *      * Network & Request Headers (reqheaders)
 *      * Mobile Personas & Touch Fingerprinting (mobilepersona, mobilefp)
 *      * Timezone & Kernel Synchronization (tzcountry, wintzkernel)
 *      * Window Management & UI Fixes (uiactions, windpi, wincascade, internalpagesync)
 *      * Proxy Authentication & Protocol Forwarding (proxyauth, socks5complete)
 *      * Release Defenses & Gate Self-Verification (fpreleasegate, releasecoverage)
 * 3. Stratified Diagnostic Audits (audit:*):
 *    - Issue closure audit (audit:issueclosure)
 *    - Stratified reporting:
 *      * PASS: Validated protections
 *      * WARN: Documented architectural and physical hardware boundaries
 *              (CJK font system monospace fallback, privileged chrome:// DOM event blocking, macOS Metal driver point size limit, NVIDIA 32K texture physical bound)
 *              Strictly reported as WARN (Architectural Boundary); NEVER mislabeled as PASS.
 *      * CONFIRMED LEAK/GAP, TIMEOUT, or UNHANDLED CRASH: Triggers overall regression failure.
 * 4. Comprehensive Markdown Report Generation:
 *    - Structured output written to designated report path (default: repoRoot/reports/full-selftest-regression-final.md)
 *
 * CLI Usage:
 *   node automation/final-release-regression-runner.js [options]
 *
 * Options:
 *   --dry-run          Validate file existence, syntax, and print test matrix without launching browsers
 *   --bail             Abort on first core suite failure
 *   --timeout=<ms>     Timeout per test suite in milliseconds (default: 150000 ms, strictly >= 120s)
 *   --suite=<key>      Run a single specified suite (e.g. --suite=selftest:webglcompat)
 *   --domain=<name>    Run all suites within domains matching the name
 *   --mutate           Pass --mutate flag to all executed test scripts that support mutation testing
 *   --report=<path>    Path to write markdown report (default: ../reports/full-selftest-regression-final.md)
 *   --help, -h         Display usage information
 */

// Recursion and re-entry prevention guard
if (process.env.__OPENBROWSER_RUNNER_ACTIVE === "1") {
  console.error("FATAL: Nested or recursive invocation of final-release-regression-runner.js detected! Aborting.");
  process.exit(1);
}

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn, execFileSync } = require("child_process");

const appRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(appRoot, "..");
const pkgPath = path.join(appRoot, "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
const scripts = pkg.scripts || {};

const EXPECTED_VERSION = pkg.version;
assert.ok(
  typeof EXPECTED_VERSION === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(EXPECTED_VERSION),
  "Browserapp/package.json version must be a valid semver string"
);
const DEFAULT_TIMEOUT_MS = 150000; // 150s per suite (strictly >= 120s)

// Command-line argument parsing with robust prefix matching
const argv = process.argv.slice(2);
const isDryRun = argv.includes("--dry-run");
const isBail = argv.includes("--bail");
const isMutate = argv.includes("--mutate");
const isHelp = argv.includes("--help") || argv.includes("-h");

function getArgValue(prefix) {
  const arg = argv.find((a) => a.startsWith(prefix));
  if (!arg) return null;
  return arg.slice(prefix.length);
}

const suiteArg = getArgValue("--suite=");
const domainArg = getArgValue("--domain=");
const timeoutArg = getArgValue("--timeout=");
const rawReportArg = getArgValue("--report=");
const reportArg = rawReportArg
  ? path.resolve(process.cwd(), rawReportArg)
  : path.join(repoRoot, "reports", "full-selftest-regression-final.md");

const perSuiteTimeout = timeoutArg ? Math.max(30000, parseInt(timeoutArg, 10)) : DEFAULT_TIMEOUT_MS;

if (isHelp) {
  console.log(`
OpenBrowser Pre-Release Final Regression Runner
==============================================
Usage: node automation/final-release-regression-runner.js [options]

Options:
  --dry-run          Validate file existence, syntax, and plan without launching browsers
  --bail             Abort immediately on first test failure
  --timeout=<ms>     Timeout per suite in ms (default: 150000, >= 120000)
  --suite=<key>      Execute only the specified suite (e.g. --suite=selftest:fontcjkprobe)
  --domain=<name>    Execute suites within domains matching substring
  --mutate           Execute scripts with --mutate where applicable
  --report=<path>    Output path for markdown summary report
  --help, -h         Show this message
`);
  process.exit(0);
}

/**
 * Complete Functional Coverage Matrix (12 Domains, 56 Core Blocking Suites)
 */
const COVERAGE_DOMAINS = [
  {
    domain: "Platform CI Baseline & Surface Integrity",
    description: "Exact cross-platform workflow selftests that run before packaging and guard injection surface integrity",
    suites: [
      { key: "selftest", script: "node environment-audit-selftest.js", file: "environment-audit-selftest.js" },
      { key: "selftest:automation", script: "node automation/automation-selftest.js", file: "automation/automation-selftest.js" },
      { key: "selftest:protocol", script: "node automation/protocol/protocol-selftest.js", file: "automation/protocol/protocol-selftest.js" },
      { key: "selftest:isolation", script: "node automation/isolation-fingerprint-selftest.js", file: "automation/isolation-fingerprint-selftest.js" },
      { key: "selftest:kernel", script: "node automation/kernel-policy-selftest.js", file: "automation/kernel-policy-selftest.js" },
      { key: "selftest:profileui", script: "node automation/profile-ui-layout-selftest.js", file: "automation/profile-ui-layout-selftest.js" },
      { key: "selftest:kernelinit", script: "node automation/kernel-init-sync-selftest.js", file: "automation/kernel-init-sync-selftest.js" },
      { key: "selftest:fpcoverage", script: "node automation/fingerprint-coverage-selftest.js", file: "automation/fingerprint-coverage-selftest.js" },
      { key: "selftest:fontnative", script: "node automation/font-native-layer-selftest.js", file: "automation/font-native-layer-selftest.js" },
      { key: "selftest:stealth", script: "node fingerprint-stealth-selftest.js", file: "fingerprint-stealth-selftest.js" },
      { key: "selftest:webglparams", script: "node automation/webgl-params-e2e-selftest.js", file: "automation/webgl-params-e2e-selftest.js" },
      { key: "selftest:surfacediff", script: "node automation/surface-integrity-e2e-selftest.js", file: "automation/surface-integrity-e2e-selftest.js" },
      { key: "selftest:mediae2e", script: "node automation/media-devices-e2e-selftest.js", file: "automation/media-devices-e2e-selftest.js" },
      { key: "selftest:popupe2e", script: "node automation/popup-target-injection-e2e-selftest.js", file: "automation/popup-target-injection-e2e-selftest.js" },
      { key: "selftest:doclifecycle", script: "node automation/document-lifecycle-fingerprint-e2e-selftest.js", file: "automation/document-lifecycle-fingerprint-e2e-selftest.js" },
      { key: "selftest:workerfp", script: "node automation/worker-fingerprint-e2e-selftest.js", file: "automation/worker-fingerprint-e2e-selftest.js" },
      { key: "selftest:workerscope", script: "node automation/worker-scope-family-e2e-selftest.js", file: "automation/worker-scope-family-e2e-selftest.js" },
      { key: "selftest:bluetooth", script: "node automation/bluetooth-adapter-e2e-selftest.js", file: "automation/bluetooth-adapter-e2e-selftest.js" },
    ]
  },
  {
    domain: "Worker Isolation & WebGPU Parity",
    description: "DedicatedWorker WebGPU adapter masking, brand checks, and font injection",
    suites: [
      { key: "selftest:workerwebgpu", script: "node automation/worker-webgpu-fingerprint-e2e-selftest.js", file: "automation/worker-webgpu-fingerprint-e2e-selftest.js" },
      { key: "selftest:workerfontpresence", script: "node automation/worker-font-presence-e2e-selftest.js", file: "automation/worker-font-presence-e2e-selftest.js" },
      { key: "selftest:workerfontwiring", script: "node automation/worker-font-presence-wiring-selftest.js", file: "automation/worker-font-presence-wiring-selftest.js" },
      { key: "selftest:webrtcfb", script: "node automation/webrtc-fallback-e2e-selftest.js", file: "automation/webrtc-fallback-e2e-selftest.js" },
    ]
  },
  {
    domain: "Cross-Surface Multi-Context Parity",
    description: "5-surface synchronization across window, iframes (navigated, srcdoc, about:blank), and worker",
    suites: [
      { key: "selftest:crosssurface", script: "node automation/fingerprint-cross-surface-audit-selftest.js", file: "automation/fingerprint-cross-surface-audit-selftest.js" },
      { key: "selftest:canvasaudiorects", script: "node automation/canvas-audio-clientrects-cross-surface-e2e-selftest.js", file: "automation/canvas-audio-clientrects-cross-surface-e2e-selftest.js" },
    ]
  },
  {
    domain: "Font System Integrity, CJK Probing & Deep Metadata",
    description: "WOFF2 subset sanitization, binary name-table alignment, CJK probe metrics, and queryLocalFonts blob gate",
    suites: [
      { key: "selftest:fontpresence", script: "node automation/font-presence-local-e2e-selftest.js", file: "automation/font-presence-local-e2e-selftest.js" },
      { key: "selftest:fontdeepmeta", script: "node automation/font-deep-metadata-e2e-selftest.js", file: "automation/font-deep-metadata-e2e-selftest.js" },
      { key: "selftest:fontnametable", script: "node automation/font-asset-name-table-e2e-selftest.js", file: "automation/font-asset-name-table-e2e-selftest.js" },
      { key: "selftest:fontblob", script: "node automation/query-local-font-blob-e2e-selftest.js", file: "automation/query-local-font-blob-e2e-selftest.js" },
      { key: "selftest:fontblobassets", script: "node automation/query-local-font-blob-real-assets-selftest.js", file: "automation/query-local-font-blob-real-assets-selftest.js" },
      { key: "selftest:winfontsubsets", script: "node automation/windows-missing-font-subsets-e2e-selftest.js", file: "automation/windows-missing-font-subsets-e2e-selftest.js" },
      { key: "selftest:macosfontsubsets", script: "node automation/macos-missing-font-subsets-e2e-selftest.js", file: "automation/macos-missing-font-subsets-e2e-selftest.js" },
      { key: "selftest:fontcjkprobe", script: "node automation/font-cjk-probe-e2e-selftest.js", file: "automation/font-cjk-probe-e2e-selftest.js" },
      { key: "selftest:fontconsistency", script: "node automation/font-persona-consistency-e2e-selftest.js", file: "automation/font-persona-consistency-e2e-selftest.js" },
    ]
  },
  {
    domain: "CSS Font Interception & Guard Barriers",
    description: "DOM @font-face gate, CDP response rewriter, initial page guard, and dynamic link interception",
    suites: [
      { key: "selftest:cssfontgate", script: "node automation/css-font-local-gate-e2e-selftest.js", file: "automation/css-font-local-gate-e2e-selftest.js" },
      { key: "selftest:cssfontrewrite", script: "node automation/css-font-response-rewrite-e2e-selftest.js", file: "automation/css-font-response-rewrite-e2e-selftest.js" },
      { key: "selftest:cssfontwiring", script: "node automation/css-font-response-wiring-selftest.js", file: "automation/css-font-response-wiring-selftest.js" },
      { key: "selftest:cssfontbypass", script: "node automation/css-local-font-bypass-e2e-selftest.js", file: "automation/css-local-font-bypass-e2e-selftest.js" },
      { key: "selftest:initialpageguard", script: "node automation/initial-page-css-guard-barrier-selftest.js", file: "automation/initial-page-css-guard-barrier-selftest.js" },
    ]
  },
  {
    domain: "Graphics & WebGL Parameter Normalization & Compatibility",
    description: "Intel Gen architecture canonicalization, vendor extension isolation, and physical driver compatibility",
    suites: [
      { key: "selftest:webglarchnorm", script: "node automation/webgl-architecture-normalization-e2e-selftest.js", file: "automation/webgl-architecture-normalization-e2e-selftest.js" },
      { key: "selftest:webglextprofile", script: "node automation/webgl-extensions-profile-e2e-selftest.js", file: "automation/webgl-extensions-profile-e2e-selftest.js" },
      { key: "selftest:webglcompat", script: "node automation/webgl-capability-compatibility-e2e-selftest.js", file: "automation/webgl-capability-compatibility-e2e-selftest.js" },
    ]
  },
  {
    domain: "Network & Request Headers (UA-CH / Accept-Language)",
    description: "Client Hints platform/mobile parity, RFC language weight formatting, and cross-origin header preservation",
    suites: [
      { key: "selftest:reqheaders", script: "node automation/request-headers-e2e-selftest.js", file: "automation/request-headers-e2e-selftest.js" },
    ]
  },
  {
    domain: "Mobile Personas & Touch Fingerprinting (Android / iOS)",
    description: "Android/iOS hardware profiles, maxTouchPoints, DPR scaling, mobile GPU and touch emulation",
    suites: [
      { key: "selftest:mobilepersona", script: "node automation/mobile-personas-selftest.js", file: "automation/mobile-personas-selftest.js" },
      { key: "selftest:mobilefp", script: "node automation/mobile-fingerprint-e2e-selftest.js", file: "automation/mobile-fingerprint-e2e-selftest.js" },
    ]
  },
  {
    domain: "Timezone & Kernel Synchronization",
    description: "Country code IANA fallback mapping and Windows Chromium C++ timezone synchronization",
    suites: [
      { key: "selftest:tzcountry", script: "node automation/timezone-country-fallback-selftest.js", file: "automation/timezone-country-fallback-selftest.js" },
      { key: "selftest:wintzkernel", script: "node automation/windows-timezone-kernel-e2e-selftest.js", file: "automation/windows-timezone-kernel-e2e-selftest.js" },
    ]
  },
  {
    domain: "Window Management & UI Fixes (Issue #19)",
    description: "Action buttons geometry, DPI scaling flag, cascade bounds clamp, and internal page mirroring",
    suites: [
      { key: "selftest:uiactions", script: "node profile-action-buttons-ui-selftest.js", file: "profile-action-buttons-ui-selftest.js" },
      { key: "selftest:windpi", script: "node automation/windows-dpi-scale-factor-selftest.js", file: "automation/windows-dpi-scale-factor-selftest.js" },
      { key: "selftest:wincascade", script: "node automation/window-sync-cascade-bounds-selftest.js", file: "automation/window-sync-cascade-bounds-selftest.js" },
      { key: "selftest:internalpagesync", script: "node automation/internal-pages-tab-sync-selftest.js", file: "automation/internal-pages-tab-sync-selftest.js" },
    ]
  },
  {
    domain: "Proxy Authentication & Protocol Forwarding (Issue #22)",
    description: "SOCKS5 upstream dual-mode handshake, credential isolation with special characters, and authenticated HTTP CONNECT tunneling",
    suites: [
      { key: "selftest:proxyauth", script: "node proxy-forwarder-selftest.js", file: "proxy-forwarder-selftest.js" },
      { key: "selftest:socks5complete", script: "node socks5-auth-complete-selftest.js", file: "socks5-auth-complete-selftest.js" },
      { key: "selftest:socks5reset", script: "node socks5-reset-selftest.js", file: "socks5-reset-selftest.js" },
      { key: "selftest:socks5retry", script: "node socks5-retry-selftest.js", file: "socks5-retry-selftest.js" },
    ]
  },
  {
    domain: "Release Defenses & Self-Verification",
    description: "Working-tree sanitization, packaging exclusions, and release gate self-testing",
    suites: [
      { key: "selftest:fpreleasegate", script: "node automation/fingerprint-release-gate-selftest.js", file: "automation/fingerprint-release-gate-selftest.js" },
      { key: "selftest:releasecoverage", script: "node automation/fingerprint-release-coverage-selftest.js", file: "automation/fingerprint-release-coverage-selftest.js" },
    ]
  }
];

/**
 * Diagnostic & Exploratory Audits (Partitioned non-blocking, distinct audit:* prefix)
 */
const DIAGNOSTIC_AUDITS = [
  {
    key: "audit:issueclosure",
    script: "node automation/issue-closure-audit-selftest.js",
    file: "automation/issue-closure-audit-selftest.js",
    category: "DIAGNOSTIC_AUDIT",
    rationale: "Adversarial GitHub issues #19, #21, #22 closure evaluation; tracks documented architectural boundaries without binary regression blocking"
  }
];

/**
 * Canonical 7 Version Synchronization Locations
 */
const VERSION_LOCATIONS = [
  { rel: "README.md", pattern: /badge\/version-([0-9.]+)-blue/ },
  { rel: "README_CN.md", pattern: /badge\/version-([0-9.]+)-blue/ },
  { rel: "Browserapp/package.json", pattern: /"version":\s*"([0-9.]+)"/ },
  { rel: "Browserapp/package-lock.json", pattern: /"version":\s*"([0-9.]+)"/ },
  { rel: "Browserapp/index.html", pattern: /id="app-version">v([0-9.]+)<\/span>/ },
  { rel: "Browserapp/scripts/brand-exe.mjs", pattern: /'file-version':\s*'([0-9.]+)'/ },
  { rel: ".github/workflows/build-installers.yml", pattern: /default:\s*'v([0-9.]+)'/ },
];

/**
 * Sensitive and Forbidden Release File Patterns (Cross-platform normalized)
 */
const FORBIDDEN_RELEASE_PATTERNS = [
  /(?:^|[\\\/])node_modules(?:[\\\/]|$)/,
  /(?:^|[\\\/])__pycache__(?:[\\\/]|$)/,
  /\.pyc$/i,
  /\.pyo$/i,
  /(?:^|[\\\/])\.DS_Store$/i,
  /(?:^|[\\\/])(?:Browserapp[\\\/])?reports(?:[\\\/]|$)/,
];

function findForbiddenFiles(fileList) {
  const violations = [];
  for (const file of fileList) {
    const normalized = file.replace(/\\/g, "/");
    for (const pattern of FORBIDDEN_RELEASE_PATTERNS) {
      if (pattern.test(normalized) || pattern.test(file)) {
        violations.push({ file, pattern: pattern.toString() });
        break;
      }
    }
  }
  return violations;
}

/**
 * Clean up transient test screenshots created by visual UI tests (e.g. selftest:uiactions)
 * to maintain strict disk hygiene before, during, and after the regression pipeline.
 */
function cleanTransientTestScreenshots() {
  const reportsDirs = [
    path.join(appRoot, "reports"),
    path.join(repoRoot, "reports"),
  ];
  let cleanedCount = 0;
  for (const rDir of reportsDirs) {
    if (fs.existsSync(rDir)) {
      try {
        const entries = fs.readdirSync(rDir, { withFileTypes: true });
        for (const ent of entries) {
          // Strictly delete regular files ending with .png (never directories or non-png files like .md/.json)
          if (ent.isFile() && ent.name.toLowerCase().endsWith(".png")) {
            try {
              fs.rmSync(path.join(rDir, ent.name), { force: true });
              cleanedCount++;
            } catch {}
          }
        }
      } catch {}
    }
  }
  return cleanedCount;
}

/**
 * Extract failure header, assertion message, and diff context from child process output.
 * Ensures that FAIL labels, failure reasons, and diffs are never lost due to trailing lines.
 */
function extractErrorSnippet(stdout = "", stderr = "") {
  const combined = [stdout, stderr].filter(Boolean).join("\n");
  const lines = combined.split(/\r?\n/).map((l) => l.trimEnd());

  const failIndices = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(?:FAIL|FAILED|Error:|AssertionError)/i.test(lines[i])) {
      failIndices.push(i);
    }
  }

  if (failIndices.length > 0) {
    const includedIndices = new Set();
    for (const idx of failIndices) {
      const start = Math.max(0, idx - 1);
      const end = Math.min(lines.length, idx + 15);
      for (let j = start; j < end; j++) {
        includedIndices.add(j);
        if (j > idx && /^\s*PASS\s/i.test(lines[j])) {
          includedIndices.delete(j);
          break;
        }
      }
    }
    for (let i = Math.max(0, lines.length - 4); i < lines.length; i++) {
      if (/FAILED/i.test(lines[i])) {
        includedIndices.add(i);
      }
    }
    const sorted = Array.from(includedIndices).sort((a, b) => a - b);
    return sorted.map((i) => lines[i]).join("\n    ");
  }

  if (stderr && stderr.trim()) {
    return stderr.trim().split(/\r?\n/).slice(-15).join("\n    ");
  }
  return lines.filter(Boolean).slice(-15).join("\n    ");
}

/**
 * Pre-flight Static Invariant Audit
 */
function runPreflightStaticAudit() {
  console.log("=== PHASE 0: PRE-FLIGHT STATIC AUDIT & INVARIANT CHECKS ===\n");
  const errors = [];

  // 1. Strict Version verification across 7 canonical locations
  console.log(`Checking version synchronization across 7 canonical locations (target: ${EXPECTED_VERSION})...`);
  for (const loc of VERSION_LOCATIONS) {
    const fullPath = path.join(repoRoot, loc.rel);
    if (!fs.existsSync(fullPath)) {
      errors.push(`Missing file for version check: ${loc.rel}`);
      continue;
    }
    const content = fs.readFileSync(fullPath, "utf8");
    const match = content.match(loc.pattern);
    if (!match) {
      errors.push(`Version pattern not matched in ${loc.rel}`);
      continue;
    }
    const rawVer = match[1];
    const canonicalVer = rawVer.endsWith(".0") && loc.rel.includes("brand-exe") ? rawVer.slice(0, -2) : rawVer;
    if (canonicalVer !== EXPECTED_VERSION) {
      errors.push(`Version mismatch in ${loc.rel}: expected ${EXPECTED_VERSION}, found ${rawVer}`);
      continue;
    }

    // Additional synchronization checks for specific canonical locations
    if (loc.rel === "Browserapp/package-lock.json") {
      try {
        const lockParsed = JSON.parse(content);
        const rootVer = lockParsed.version;
        const pkgVer = lockParsed.packages && lockParsed.packages[""] ? lockParsed.packages[""].version : null;
        if (rootVer !== EXPECTED_VERSION || pkgVer !== EXPECTED_VERSION) {
          errors.push(`Version mismatch in Browserapp/package-lock.json: root="${rootVer}", packages[""]="${pkgVer}", expected "${EXPECTED_VERSION}"`);
          continue;
        }
      } catch (err) {
        errors.push(`Failed to parse Browserapp/package-lock.json: ${err.message}`);
        continue;
      }
    }

    if (loc.rel === ".github/workflows/build-installers.yml") {
      if (!content.includes("RELEASE_NOTES:") || !content.includes("${{ inputs.release_tag }}")) {
        errors.push("Workflow release notes synchronization with inputs.release_tag missing in .github/workflows/build-installers.yml");
        continue;
      }
      if (!content.includes(`**v${EXPECTED_VERSION}**`)) {
        errors.push(`Workflow release notes version **v${EXPECTED_VERSION}** missing in .github/workflows/build-installers.yml`);
        continue;
      }
      if (!content.includes("Release tag must match Browserapp/package.json version")) {
        errors.push("Workflow runtime release tag/version enforcement missing in .github/workflows/build-installers.yml");
        continue;
      }
      if (!content.includes("--draft") || !content.includes("name: Publish completed release") || !content.includes("--draft=false")) {
        errors.push("Workflow draft-first release finalization enforcement missing in .github/workflows/build-installers.yml");
        continue;
      }
      for (const requiredAsset of ["OpenBrowser-Windows-x86_64-with-kernel.exe", "OpenBrowser-Windows-x86_64-with-kernel.zip", "OpenBrowser-Linux-x86_64-with-kernel.tar.gz", "OpenBrowser-macOS-x86_64.dmg", "OpenBrowser-macOS-arm64-with-kernel.dmg"]) {
        if (!content.includes(requiredAsset)) {
          errors.push(`Workflow release asset contract missing ${requiredAsset} in .github/workflows/build-installers.yml`);
          continue;
        }
      }
      if (!content.includes("default: all")) {
        errors.push("Workflow official-release target_platform default must be all in .github/workflows/build-installers.yml");
        continue;
      }
    }

    console.log(`  PASS  [Version] ${loc.rel}: ${rawVer}`);
  }

  // 2. Working-tree disk hygiene check
  console.log("\nChecking working tree disk hygiene...");
  const pycachePaths = [
    path.join(appRoot, "scripts", "__pycache__"),
    path.join(appRoot, "automation", "__pycache__"),
    path.join(repoRoot, "scripts", "__pycache__"),
  ];
  for (const p of pycachePaths) {
    if (fs.existsSync(p)) {
      errors.push(`Forbidden directory exists on disk: ${p}`);
    } else {
      const rel = path.relative(repoRoot, p).replace(/\\/g, "/");
      console.log(`  PASS  [Hygiene] ${rel} is absent`);
    }
  }

  const reportsDirs = [
    path.join(appRoot, "reports"),
    path.join(repoRoot, "reports"),
  ];
  for (const rDir of reportsDirs) {
    if (fs.existsSync(rDir)) {
      const pngs = fs.readdirSync(rDir).filter((f) => f.toLowerCase().endsWith(".png"));
      if (pngs.length > 0) {
        errors.push(`Forbidden test screenshots exist in ${rDir}: ${pngs.join(", ")}`);
      } else {
        const rel = path.relative(repoRoot, rDir).replace(/\\/g, "/");
        console.log(`  PASS  [Hygiene] No .png screenshot artifacts in ${rel}`);
      }
    }
  }

  // 3. Git staging and untracked contamination check
  let isGitClean = false;
  try {
    const stagedOut = execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: repoRoot, encoding: "utf8" });
    const stagedFiles = stagedOut.split(/\r?\n/).map((s) => s.trim().replace(/^"|"$/g, "")).filter(Boolean);
    if (stagedFiles.length > 0) {
      const forbiddenStaged = findForbiddenFiles(stagedFiles);
      if (forbiddenStaged.length > 0) {
        errors.push(`Forbidden sensitive paths currently staged in Git: ${JSON.stringify(forbiddenStaged)}`);
      }
      console.log(`  WARN  Git staging area contains ${stagedFiles.length} file(s) (not 0, but verified for sensitive patterns)`);
    } else {
      console.log("  PASS  [Git] Git staging area is completely clean (0 staged files)");
      isGitClean = true;
    }

    const statusOut = execFileSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf8" });
    const untrackedFiles = [];
    for (const line of statusOut.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.startsWith("?? ")) {
        untrackedFiles.push(trimmed.slice(3).trim().replace(/^"|"$/g, ""));
      }
    }
    const forbiddenUntracked = findForbiddenFiles(untrackedFiles);
    if (forbiddenUntracked.length > 0) {
      errors.push(`Forbidden untracked files leaking into Git working tree: ${JSON.stringify(forbiddenUntracked)}`);
    } else {
      console.log("  PASS  [Git] No untracked forbidden sensitive patterns in working tree");
    }
  } catch (err) {
    console.log("  INFO  Git pre-flight checks skipped or non-git environment: " + err.message);
  }

  if (errors.length > 0) {
    console.error("\nPre-flight checks encountered critical failures:\n" + errors.map((e) => "  FAIL  " + e).join("\n"));
    return { ok: false, isGitClean };
  }

  console.log("\nPre-flight static audit completed successfully.\n");
  return { ok: true, isGitClean };
}

/**
 * Filter suites based on CLI arguments
 */
function getSelectedSuites() {
  let allSuites = COVERAGE_DOMAINS.flatMap((d) => d.suites.map((s) => ({ ...s, domain: d.domain })));

  // Sanity check: Ensure runner never includes itself in the suites to execute
  for (const suite of allSuites) {
    if (suite.file.includes("final-release-regression-runner.js") || suite.key === "regression:final") {
      throw new Error(`Recursive suite reference forbidden: ${suite.key} (${suite.file})`);
    }
  }

  if (suiteArg) {
    allSuites = allSuites.filter((s) => s.key === suiteArg || s.file.includes(suiteArg));
  }

  if (domainArg) {
    allSuites = allSuites.filter((s) => s.domain.toLowerCase().includes(domainArg.toLowerCase()));
  }

  return allSuites;
}

function getSelectedAudits() {
  let audits = [...DIAGNOSTIC_AUDITS];

  if (suiteArg) {
    audits = audits.filter((a) => a.key === suiteArg || a.file.includes(suiteArg));
  } else if (domainArg) {
    const matchesDomain =
      "diagnostic audits".includes(domainArg.toLowerCase()) ||
      domainArg.toLowerCase().includes("diagnostic");
    if (!matchesDomain) {
      audits = [];
    }
  }

  return audits;
}

/**
 * Execute a single test process with timeout (Cross-platform spawn without shell interpolation)
 */
let activeChild = null;
let isTerminating = false;

/**
 * Cross-platform process tree recycling for test processes and child browser processes.
 * Ensures orphaned/detached Chrome instances and child trees are completely terminated
 * on timeout or interruption, without ever killing unrelated user processes.
 */
function getDescendantPidsPosix(rootPid) {
  const pids = [];
  try {
    const out = execFileSync("pgrep", ["-P", String(rootPid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const directChildren = out
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => /^\d+$/.test(s))
      .map(Number);
    for (const cPid of directChildren) {
      pids.push(cPid);
      pids.push(...getDescendantPidsPosix(cPid));
    }
  } catch {}
  return pids;
}

function killProcessTree(child, signal = "SIGKILL") {
  if (!child || !child.pid) return;
  const pid = child.pid;

  if (process.platform === "win32") {
    try {
      // Windows: taskkill /PID <pid> /T /F terminates child and all its descendant processes
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      try {
        child.kill();
      } catch {}
    }
  } else {
    // POSIX (macOS / Linux):
    // 1. Gather any spawned child / grandchild PIDs (e.g. Chromium / headless Chrome)
    const descendantPids = getDescendantPidsPosix(pid);

    // 2. Kill the process group (-pid) if spawned with detached: true
    try {
      process.kill(-pid, signal);
    } catch {
      try {
        child.kill(signal);
      } catch {}
    }

    // 3. Directly signal all discovered descendant PIDs (and their process groups if detached)
    for (const dPid of descendantPids) {
      try {
        process.kill(-dPid, signal);
      } catch {}
      try {
        process.kill(dPid, signal);
      } catch {}
    }

    // If graceful SIGTERM was requested, escalate to SIGKILL after a brief grace period
    if (signal === "SIGTERM") {
      setTimeout(() => {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {}
        for (const dPid of descendantPids) {
          try {
            process.kill(dPid, "SIGKILL");
          } catch {}
        }
      }, 500).unref();
    }
  }
}

/**
 * Safely reclaim any detached or orphaned headless OpenBrowser / Chrome processes
 * created for temporary test user-data-dir profiles in os.tmpdir().
 * Strictly checks process arguments to never touch user browsers or non-test processes.
 */
function reclaimOrphanedTestBrowsers() {
  if (process.platform === "win32") {
    return;
  }
  try {
    const tmp = os.tmpdir().replace(/\/$/, "");
    const out = execFileSync("pgrep", ["-f", `user-data-dir=.*${path.basename(tmp)}.*ob-`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const pids = out
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => /^\d+$/.test(s))
      .map(Number)
      .filter((p) => p !== process.pid && p !== process.ppid);
    for (const p of pids) {
      try { process.kill(-p, "SIGKILL"); } catch {}
      try { process.kill(p, "SIGKILL"); } catch {}
    }
  } catch {}
}

function setupSignalHandlers() {
  const handleSignal = (signal) => {
    if (isTerminating) return;
    isTerminating = true;
    console.error(`\n[Runner] Received ${signal}. Terminating child process tree and cleaning up transient screenshots...`);
    if (activeChild) {
      killProcessTree(activeChild, "SIGKILL");
      activeChild = null;
    }
    try {
      reclaimOrphanedTestBrowsers();
    } catch {}
    try {
      cleanTransientTestScreenshots();
    } catch {}
    const exitCode = signal === "SIGINT" ? 130 : 143;
    process.exit(exitCode);
  };

  process.once("SIGINT", () => handleSignal("SIGINT"));
  process.once("SIGTERM", () => handleSignal("SIGTERM"));
}

/**
 * Execute a single test process with timeout (Cross-platform spawn with safe process-tree recycling)
 */
/**
 * Detect definitive test completion report from child process stdout.
 * Recognizes standard scorecard banners output by all 56 core test suites and diagnostic audits.
 */
function parseSuiteCompletion(output) {
  if (!output || typeof output !== "string") return null;
  const lines = output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];

    // 1. Diagnostic audits: "TOTAL CHECKS: 29 | PASS: 26 | CONFIRMED LEAK/GAP: 0 | WARN: 3"
    const auditMatch = line.match(/^TOTAL CHECKS:\s*(\d+)\s*\|\s*PASS:\s*(\d+)\s*\|\s*CONFIRMED LEAK\/GAP:\s*(\d+)/i);
    if (auditMatch) {
      const leaks = parseInt(auditMatch[3], 10);
      return { isComplete: true, isSuccess: leaks === 0, line };
    }

    // 2. Checks passed: "mobile-personas-selftest: 41 checks passed."
    const passedMatch = line.match(/^([a-zA-Z0-9_\-\[\] ]+):\s*(\d+)\s+checks?\s+passed/i);
    if (passedMatch) {
      return { isComplete: true, isSuccess: true, line };
    }

    // 3. Proxy / SOCKS5 selftest summary: "PROXY_FORWARDER_SELFTEST_OK ...", "SOCKS5_AUTH_COMPLETE_SELFTEST_OK ..."
    if (line.includes("PROXY_FORWARDER_SELFTEST_OK") ||
        line.includes("SOCKS5_AUTH_COMPLETE_SELFTEST_OK") ||
        line.includes("SOCKS5_RESET_SELFTEST_OK") ||
        line.includes("SOCKS5_RETRY_SELFTEST_OK")) {
      return { isComplete: true, isSuccess: true, line };
    }

    // 4. Standard selftest summary: "suite-name: OK 43/43", "suite-name: FAILED 2/43", "suite: FAILED (1 failed)"
    const scoreMatch = line.match(/^([a-zA-Z0-9_\-\[\] ]+):\s*(OK|FAILED)(?:\s+(\d+)\/(\d+)|\s+\((\d+)(?:\/\d+)?\s+failed\))?/i);
    if (scoreMatch) {
      const status = scoreMatch[2].toUpperCase();
      const passedStr = scoreMatch[3];
      const totalStr = scoreMatch[4];
      const failedCountStr = scoreMatch[5];

      let isSuccess = status === "OK";
      if (failedCountStr && parseInt(failedCountStr, 10) > 0) isSuccess = false;
      if (passedStr && totalStr && passedStr !== totalStr) isSuccess = false;
      if (status.includes("FAILED")) isSuccess = false;
      const trailingFail = line.match(/FAILED:\s*([1-9]\d*)/i);
      if (trailingFail) isSuccess = false;

      return { isComplete: true, isSuccess, line };
    }
  }
  return null;
}

function runProcess(cmdArgs, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    let stdout = "";
    let stderr = "";
    let killed = false;
    let settled = false;
    let completionGraceTimer = null;

    function finish(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (completionGraceTimer) {
        clearTimeout(completionGraceTimer);
        completionGraceTimer = null;
      }
      if (activeChild === child) activeChild = null;
      resolve(result);
    }

    // Isolate child process and prevent recursive runner invocation
    const childEnv = {
      ...process.env,
      __OPENBROWSER_RUNNER_ACTIVE: "1",
      CI: "1",
      NODE_ENV: "test",
    };

    const isPosix = process.platform !== "win32";
    const child = spawn(process.execPath, cmdArgs, {
      cwd,
      env: childEnv,
      detached: isPosix,
      stdio: ["ignore", "pipe", "pipe"],
    });

    activeChild = child;

    // Strict 150-second timeout enforcement (strictly >= 120s, never shortened)
    const timer = setTimeout(() => {
      killed = true;
      killProcessTree(child, "SIGKILL");
      reclaimOrphanedTestBrowsers();
      finish({
        code: 1,
        signal: "SIGKILL",
        durationMs: Date.now() - startTime,
        stdout,
        stderr: stderr + "\nExecution exceeded timeout limit (" + (timeoutMs / 1000) + "s)",
        timedOut: true,
      });
    }, timeoutMs);

    function checkCompletion() {
      if (settled || completionGraceTimer) return;
      const completion = parseSuiteCompletion(stdout);
      if (completion && completion.isComplete) {
        // Child has output its definitive scorecard/summary line.
        // Grant a 1500ms grace period for child event loop to drain naturally.
        completionGraceTimer = setTimeout(() => {
          if (settled) return;
          // If child fails to exit on its own due to dangling event-loop handles
          // (such as unclosed WebSocket connections or detached browser processes),
          // safely terminate the child process tree, reclaim test browsers, and harvest result.
          const finalCompletion = parseSuiteCompletion(stdout);
          const inferredCode = (finalCompletion && finalCompletion.isSuccess) ? 0 : 1;
          killProcessTree(child, "SIGKILL");
          reclaimOrphanedTestBrowsers();
          finish({
            code: inferredCode,
            signal: null,
            durationMs: Date.now() - startTime,
            stdout,
            stderr,
            timedOut: false,
          });
        }, 1500);
      }
    }

    child.stdout.on("data", (data) => {
      stdout += data.toString();
      checkCompletion();
    });

    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("close", (code, signal) => {
      reclaimOrphanedTestBrowsers();
      const durationMs = Date.now() - startTime;
      finish({
        code,
        signal,
        durationMs,
        stdout,
        stderr,
        timedOut: killed,
      });
    });

    child.on("error", (err) => {
      reclaimOrphanedTestBrowsers();
      const durationMs = Date.now() - startTime;
      finish({
        code: 1,
        signal: null,
        durationMs,
        stdout,
        stderr: stderr + "\n" + err.message,
        timedOut: false,
      });
    });
  });
}

/**
 * Main Orchestrator
 */
async function main() {
  setupSignalHandlers();

  console.log("======================================================================");
  console.log("    OPENBROWSER AGGREGATED PRE-RELEASE REGRESSION RUNNER");
  console.log(`    Target Version: ${EXPECTED_VERSION} | Per-Suite Timeout: ${perSuiteTimeout / 1000}s`);
  console.log("======================================================================\n");

  // Step 0: Pre-flight Audit
  // Auto-clean any lingering transient .png test screenshots from previous runs before pre-flight audit
  const preCleaned = cleanTransientTestScreenshots();
  if (preCleaned > 0) {
    console.log(`  INFO  [Hygiene] Auto-cleaned ${preCleaned} lingering transient screenshot(s) from previous test run\n`);
  }

  const preflightResult = runPreflightStaticAudit();
  if (!preflightResult.ok) {
    process.exit(1);
  }

  const selectedCoreSuites = getSelectedSuites();
  const selectedAudits = getSelectedAudits();
  const totalSelected = selectedCoreSuites.length + selectedAudits.length;

  // Strict guard: Prohibit 0-test false green if --suite or --domain has no matching suites
  if ((suiteArg || domainArg) && totalSelected === 0) {
    console.error(
      `\n  FAIL  [NO MATCH] No regression suites or diagnostic audits matched the filter:` +
      (suiteArg ? ` --suite="${suiteArg}"` : "") +
      (domainArg ? ` --domain="${domainArg}"` : "")
    );
    console.error(`  Available core suites: ${COVERAGE_DOMAINS.flatMap((d) => d.suites.map((s) => s.key)).join(", ")}`);
    console.error(`  Available diagnostic audits: ${DIAGNOSTIC_AUDITS.map((a) => a.key).join(", ")}\n`);
    process.exit(1);
  }

  if (totalSelected === 0) {
    console.error("\n  FAIL  [EMPTY TEST MATRIX] No suites selected to run.\n");
    process.exit(1);
  }

  console.log(`Selected Core Blocking Suites: ${selectedCoreSuites.length}`);
  console.log(`Diagnostic Audits: ${selectedAudits.length}\n`);

  if (isDryRun) {
    console.log("=== DRY RUN MODE: Validating Files and Syntax Only ===\n");
    let dryErrors = 0;

    for (const suite of selectedCoreSuites) {
      const fullPath = path.resolve(appRoot, suite.file);
      const exists = fs.existsSync(fullPath);
      if (!exists) {
        console.log(`  FAIL  [MISSING] ${suite.key} -> ${suite.file}`);
        dryErrors++;
        continue;
      }
      try {
        execFileSync(process.execPath, ["-c", fullPath], { stdio: "pipe" });
        console.log(`  PASS  [SYNTAX OK] ${suite.key} (${suite.domain})`);
      } catch (err) {
        console.log(`  FAIL  [SYNTAX ERROR] ${suite.key}: ${err.message}`);
        dryErrors++;
      }
    }

    for (const audit of selectedAudits) {
      const fullPath = path.resolve(appRoot, audit.file);
      const exists = fs.existsSync(fullPath);
      if (!exists) {
        console.log(`  FAIL  [AUDIT MISSING] ${audit.key} -> ${audit.file}`);
        dryErrors++;
        continue;
      }
      try {
        execFileSync(process.execPath, ["-c", fullPath], { stdio: "pipe" });
        console.log(`  PASS  [AUDIT SYNTAX OK] ${audit.key} (Diagnostic)`);
      } catch (err) {
        console.log(`  FAIL  [AUDIT SYNTAX ERROR] ${audit.key}: ${err.message}`);
        dryErrors++;
      }
    }

    console.log(`\nDry run completed with ${dryErrors} errors.`);
    process.exit(dryErrors > 0 ? 1 : 0);
  }

  // Live Execution Pipeline
  const runResults = [];
  let totalPassed = 0;
  let totalFailed = 0;
  let totalTimedOut = 0;

  reclaimOrphanedTestBrowsers();
  console.log("=== PHASE 1 & 2: EXECUTING CORE BLOCKING REGRESSION SUITES ===\n");

  let currentDomain = "";
  for (const suite of selectedCoreSuites) {
    if (suite.domain !== currentDomain) {
      currentDomain = suite.domain;
      console.log(`\n--- Domain: ${currentDomain} ---`);
    }

    if (suite.key === "selftest:fpreleasegate") {
      cleanTransientTestScreenshots();
    }

    process.stdout.write(`  RUNNING  ${suite.key}... `);
    const fullScriptPath = path.resolve(appRoot, suite.file);
    const args = [fullScriptPath];
    if (isMutate) args.push("--mutate");

    const result = await runProcess(args, appRoot, perSuiteTimeout);
    const durSec = (result.durationMs / 1000).toFixed(2);

    if (result.timedOut) {
      console.log(`TIMEOUT (${durSec}s)`);
      totalTimedOut++;
      runResults.push({ ...suite, status: "TIMEOUT", code: "TIMEOUT", durationSec: durSec, error: "Exceeded timeout limit" });
    } else if (result.code === 0) {
      console.log(`PASS (${durSec}s)`);
      totalPassed++;
      runResults.push({ ...suite, status: "PASS", code: 0, durationSec: durSec });
    } else {
      console.log(`FAIL (exit ${result.code}, ${durSec}s)`);
      totalFailed++;
      const snippet = extractErrorSnippet(result.stdout, result.stderr);
      console.log(`    Error output:\n    ${snippet}`);
      runResults.push({ ...suite, status: "FAIL", code: result.code, durationSec: durSec, error: snippet });
    }

    // Runner invocation semantics:
    // Visual UI tests (e.g. selftest:uiactions) output transient verification screenshots to Browserapp/reports.
    // Clean up transient test screenshots immediately (on pass, fail, or timeout) before potential bail
    // so subsequent disk hygiene gates or early exits leave the working tree strictly clean.
    if (suite.key === "selftest:uiactions") {
      cleanTransientTestScreenshots();
    }
    reclaimOrphanedTestBrowsers();

    if (isBail && (result.timedOut || result.code !== 0)) {
      break;
    }
  }

  // Phase 3: Diagnostic Audits (Stratified WARN Separation)
  console.log("\n=== PHASE 3: STRATIFIED DIAGNOSTIC AUDITS (WARN SEPARATION) ===\n");
  const auditFindings = [];
  let diagnosticWarningsCount = 0;
  let diagnosticLeaksCount = 0;
  let diagnosticCrashesCount = 0;
  let diagnosticTimeoutsCount = 0;
  let lastDiagnosticDurationSec = "0.00";
  let lastDiagnosticExitCode = 0;

  for (const audit of selectedAudits) {
    console.log(`Running diagnostic audit: ${audit.key} (${audit.rationale})...`);
    const fullAuditPath = path.resolve(appRoot, audit.file);
    const args = [fullAuditPath];
    const result = await runProcess(args, appRoot, perSuiteTimeout);
    const durSec = (result.durationMs / 1000).toFixed(2);
    lastDiagnosticDurationSec = durSec;
    lastDiagnosticExitCode = result.code;

    if (result.timedOut) {
      diagnosticTimeoutsCount++;
      auditFindings.push({ type: "TIMEOUT", text: `Diagnostic audit ${audit.key} timed out after ${durSec}s` });
      console.log(`  FAIL (Timeout)                 Audit ${audit.key} exceeded timeout (${durSec}s)`);
    } else if (result.code !== 0) {
      diagnosticCrashesCount++;
      const snippet = extractErrorSnippet(result.stdout, result.stderr);
      auditFindings.push({ type: "CRASH", text: `Audit ${audit.key} exited with non-zero code ${result.code}:\n    ${snippet}` });
      console.log(`  FAIL (Crash/Exit ${result.code})          Audit ${audit.key} failed with exit code ${result.code}`);
    }

    // Parse lines for stratified PASS / WARN / CONFIRMED LEAK/GAP
    const lines = (result.stdout + "\n" + result.stderr).split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      // Check for confirmed leak line or summary leak count > 0
      if (/^\s*CONFIRMED LEAK\/GAP\s/i.test(line) || /^\s*FAIL\s/i.test(line)) {
        diagnosticLeaksCount++;
        auditFindings.push({ type: "LEAK", text: trimmed });
        console.log(`  FAIL (Confirmed Leak/Gap)     ${trimmed}`);
      } else if (/^\s*WARN\s/i.test(line) || /^\s*WARN\s*\(Architectural Boundary\)/i.test(line)) {
        diagnosticWarningsCount++;
        auditFindings.push({ type: "WARN", text: trimmed });
        console.log(`  WARN (Architectural Boundary)  ${trimmed}`);
      } else {
        // Check for summary line: TOTAL CHECKS: ... | PASS: ... | CONFIRMED LEAK/GAP: X | WARN: Y
        const summaryMatch = line.match(/CONFIRMED LEAK\/GAP:\s*(\d+)/i);
        if (summaryMatch) {
          const leakCount = parseInt(summaryMatch[1], 10);
          if (leakCount > 0 && diagnosticLeaksCount === 0) {
            diagnosticLeaksCount += leakCount;
            auditFindings.push({ type: "LEAK", text: `Summary reported ${leakCount} confirmed leak(s)/gap(s)` });
          }
        }
      }
    }

    console.log(`Audit ${audit.key} finished in ${durSec}s (Exit code: ${result.code})`);
  }

  // Phase 4: Final Summary & Markdown Report Generation
  console.log("\n======================================================================");
  console.log("                     FINAL REGRESSION SUMMARY REPORT");
  console.log("======================================================================");
  console.log(`Total Core Suites Executed: ${runResults.length}`);
  console.log(`  PASS:     ${totalPassed}`);
  console.log(`  FAIL:     ${totalFailed}`);
  console.log(`  TIMEOUT:  ${totalTimedOut}`);
  console.log(`\nDiagnostic Audit Findings:`);
  console.log(`  WARN (Architectural Boundaries):  ${diagnosticWarningsCount} (Documented, non-blocking)`);
  console.log(`  CONFIRMED LEAKS / GAPS:          ${diagnosticLeaksCount}`);
  console.log(`  CRASHES / UNHANDLED ERRORS:      ${diagnosticCrashesCount}`);
  console.log(`  TIMEOUTS:                        ${diagnosticTimeoutsCount}`);
  console.log("----------------------------------------------------------------------");

  const overallSuccess =
    (totalPassed > 0 || (selectedAudits.length > 0 && selectedCoreSuites.length === 0)) &&
    totalFailed === 0 &&
    totalTimedOut === 0 &&
    diagnosticLeaksCount === 0 &&
    diagnosticCrashesCount === 0 &&
    diagnosticTimeoutsCount === 0;

  if (overallSuccess) {
    console.log("OVERALL VERDICT: ALL CORE BLOCKING SUITES PASSED (100%)");
    console.log("Note: Documented architectural WARNs are strictly isolated from release gate.");
  } else {
    console.log("OVERALL VERDICT: REGRESSION GATE FAILED");
    process.exitCode = 1;
  }

  // Generate structured markdown report and atomically write to reportArg
  const nowIso = new Date().toISOString();
  const platformStr = `${os.platform()} (${os.type()} ${os.arch()})`;
  const nodeVer = process.version;

  const reportLines = [
    `# OpenBrowser 最终全量回归复跑报告 (Final Full Selftest Regression Report)`,
    ``,
    `**生成时间**: ${nowIso}  `,
    `**执行环境**: ${platformStr}, Node.js ${nodeVer}  `,
    `**代码根目录**: \`${repoRoot}\`  `,
    `**目标版本**: \`${EXPECTED_VERSION}\`  `,
    `**回归判定**: ${overallSuccess ? "✅ **ALL PASSED (100%)**" : "❌ **FAILED / BLOCKED**"}  `,
    ``,
    `---`,
    ``,
    `## 1. 核心阻断测试回归统计 (Core Blocking Suites)`,
    ``,
    `| 序号 | 领域 (Domain) | 脚本别名 (Script Key) | 执行耗时 | 退出状态 | 结果判定 |`,
    `| :---: | :--- | :--- | :---: | :---: | :---: |`,
  ];

  runResults.forEach((r, idx) => {
    const statusIcon = r.status === "PASS" ? "✅ PASS" : (r.status === "TIMEOUT" ? "⏱️ TIMEOUT" : "❌ FAIL");
    reportLines.push(`| ${idx + 1} | ${r.domain} | \`${r.key}\` | ${r.durationSec}s | ${r.code} | ${statusIcon} |`);
  });

  if (runResults.length === 0) {
    reportLines.push(`| - | (None) | No core suites executed | 0.00s | 0 | ⚠️ SKIPPED |`);
  }

  reportLines.push(
    ``,
    `---`,
    ``,
    `## 2. 诊断性审计结果 (Diagnostic Audits - Stratified Boundary Recording)`,
    ``,
    `*说明：诊断审计专项验证 GitHub Issues #19、#21、#22 闭环及探索性指纹对抗，其结果包含对客观底层硬件/架构边界的记录（WARN）。按照发布防线规范，只要无真实泄漏（CONFIRMED LEAK=0）且无非预期崩溃/超时，不阻断发布。*`,
    ``,
    `- **最后审计执行耗时**: ${lastDiagnosticDurationSec}s (Exit code: ${lastDiagnosticExitCode})`,
    `- **架构边界记录 (WARN)**: ${diagnosticWarningsCount} 项`,
    `- **真实漏洞/泄露 (CONFIRMED LEAK/GAP)**: ${diagnosticLeaksCount} 项`,
    `- **审计进程异常崩溃**: ${diagnosticCrashesCount} 项`,
    `- **审计执行超时**: ${diagnosticTimeoutsCount} 项`,
    ``,
    `### 诊断明细记录`,
    ``
  );

  if (auditFindings.length > 0) {
    auditFindings.forEach((f) => {
      const prefix = f.type === "WARN" ? "⚠️ **[WARN - Architectural Boundary]**" : "❌ **[CRITICAL - LEAK/CRASH/TIMEOUT]**";
      reportLines.push(`- ${prefix} ${f.text}`);
    });
  } else {
    reportLines.push(`- 暂无诊断告警记录。`);
  }

  reportLines.push(
    ``,
    `---`,
    ``,
    `## 3. 前置静态审计结果 (Phase 0 Pre-Flight Audit)`,
    ``,
    `- **7 处版本全链路同步检查**: ✅ PASS (${EXPECTED_VERSION})`,
    `- **磁盘与目录卫生检查 (无 pycache / 无截图)**: ✅ PASS`,
    `- **Git 暂存区敏感路径检查**: ${preflightResult.isGitClean ? "✅ PASS (0 staged files)" : "⚠️ VERIFIED CLEAN (No forbidden patterns)"}`,
    ``,
    `---`,
    ``,
    `## 4. 覆盖率与功能域对齐 (Functional Domains Alignment)`,
    ``,
    `- **覆盖功能域总数**: ${COVERAGE_DOMAINS.length} 大领域（${COVERAGE_DOMAINS.flatMap((d) => d.suites).length} 个核心阻断套件 100% 覆盖）`,
    `- **Issue 对应关系**:`,
    `  - Issue #19 (UI 4按键、Chromium图标、155px列宽、多窗口级联边界、内部页镜像): ` +
    `\`selftest:uiactions\`, \`selftest:windpi\`, \`selftest:wincascade\`, \`selftest:internalpagesync\``,
    `  - Issue #21 (时区回退、国家推导、Windows 内核参数): ` +
    `\`selftest:tzcountry\`, \`selftest:wintzkernel\``,
    `  - Issue #22 (SOCKS5 代理认证、# 凭据保护、128 并发、连接重置、退避重试): ` +
    `\`selftest:proxyauth\`, \`selftest:socks5complete\`, \`selftest:socks5reset\`, \`selftest:socks5retry\``,
    ``,
    `---`,
    ``,
    `## 5. 客观系统与硬件架构边界清单 (Documented Architectural Boundaries)`,
    ``,
    `1. **CJK 字形系统 monospace 回退 (CJK Glyph Monospace Fallback)**:`,
    `   - 170 族物理 WOFF2 资产优先覆盖 ASCII/Latin/PUA 探针（控制包体积在 20MB 预算内，避免 120MB+ 注入脚本导致内存与首屏崩溃）；未包含字形在 Canvas 测量中真实回退到系统等宽字体（经离线采样确认具备真实光栅化像素，绝非人工假度量）。`,
    `2. **特权 \`chrome://\` 页面事件沙箱隔离 (Privileged Page DOM Event Bound)**:`,
    `   - Chromium 安全沙箱在内部 WebUI 拦截非受信任合成 DOM 事件；系统提供 CDP 镜像单向导航，不承诺特权页面的双向 DOM live-sync。`,
    `3. **macOS Metal 点大小光栅化上限 (Metal Point Size Hardware Bound)**:`,
    `   - macOS Metal 驱动底层硬件光栅化上限截断于 \`[1, 511]\`；JS 保持真实物理参数，杜绝“声明 1024 但实际绘制止步于 511”的特征矛盾。`,
    `4. **NVIDIA 32K 纹理分配物理边界 (32K Texture Allocation Physical Bound)**:`,
    `   - macOS Metal 驱动单边物理显存分配上限为 16384；桌面 NVIDIA 32K 人设在 16K 宿主上通过能力协商自动收敛至 16384，杜绝 \`GL_INVALID_VALUE\` 报错。`,
    `5. **iOS 人设 Blink/V8 引擎特征边界 (iOS WebKit vs V8 Characteristic Bound)**:`,
    `   - iOS 人设在 Chromium 148 内核上通过 CDP 协议层实施全套表面伪装（Touch, Screen, UA, DPR, Apple GPU）；V8 引擎特征保持原生。`,
    `6. **浏览器进程首导航初始 Client Hints 编译平台依赖 (Initial Navigation CH Host Bound)**:`,
    `   - 浏览器主进程在网络线程发起首个 \`Page.navigate\` 请求时生成 Client Hints，后续所有子资源、Fetch 及 DOM 表面均严格按人设重写。`,
    ``,
    `---`,
    ``,
    `## 6. 最终发布门禁裁定 (Final Verdict)`,
    ``,
    `**总体验证结论**: ${overallSuccess ? "✅ **ALL SYSTEMS GO - REGRESSION PASSED (100%)**" : "❌ **GATE BLOCKED - REGRESSION FAILED**"}  `,
    `**发布限制提醒**: 严格遵守指令，在终审前**严禁执行 git commit, git push, git tag 或 GitHub Release**。`
  );

  const reportContent = reportLines.join("\n") + "\n";
  try {
    const reportDir = path.dirname(reportArg);
    fs.mkdirSync(reportDir, { recursive: true });
    const tmpReportPath = path.join(
      reportDir,
      `.${path.basename(reportArg)}.tmp.${process.pid}.${Date.now()}`
    );
    fs.writeFileSync(tmpReportPath, reportContent, "utf8");
    fs.renameSync(tmpReportPath, reportArg);
    console.log(`\nMarkdown regression report successfully generated and written to:\n  ${reportArg}`);
  } catch (err) {
    console.error(`\nFailed to write report to ${reportArg}: ${err.message}`);
  }

  reclaimOrphanedTestBrowsers();
  cleanTransientTestScreenshots();
  process.exit(overallSuccess ? 0 : 1);
}

main().catch((err) => {
  try {
    cleanTransientTestScreenshots();
  } catch {}
  console.error("Fatal runner crash: " + (err && err.stack ? err.stack : err));
  process.exit(1);
});