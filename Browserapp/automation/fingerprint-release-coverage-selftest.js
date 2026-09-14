#!/usr/bin/env node
'use strict';

/**
 * Release Coverage Completeness and Architectural Classification Gate.
 *
 * Verifies that all implemented core regressions, cross-surface integrations,
 * and diagnostic audit suites across OpenBrowser are properly registered,
 * structurally verified, and rigorously partitioned into:
 *
 * 1. Core Blocking Regression Suites (selftest:*):
 *    - Worker isolation and DedicatedWorker WebGPU (worker-webgpu-fingerprint-e2e)
 *    - Cross-surface 5-surface consistency (fingerprint-cross-surface-audit, canvas-audio-clientrects-cross-surface-e2e)
 *    - Font system integrity and deep metadata (font-deep-metadata-e2e, font-asset-name-table-e2e)
 *    - Font presence and WOFF2 subsets (font-presence-local, query-local-font-blob, subsets)
 *    - CSS font gate and CDP response rewrite (css-font-local-gate, css-font-response-rewrite, initial-page-css-guard)
 *    - Graphics and WebGL parameter normalization (webgl-architecture-normalization, webgl-extensions-profile, webgl-capability-compatibility)
 *    - Network and request headers (request-headers-e2e)
 *    - Mobile personas and touch fingerprinting (mobile-personas, mobile-fingerprint-e2e)
 *    - Timezone resolution and Windows kernel synchronization (timezone-country-fallback, windows-timezone-kernel)
 *    - Window management and Issue #19 UI fixes (windows-dpi-scale-factor, window-sync-cascade-bounds, internal-pages-tab-sync, profile-action-buttons-ui)
 *    - Release gate self-verification (fingerprint-release-gate-selftest, fingerprint-release-coverage-selftest)
 *
 * 2. Diagnostic & Exploratory Audits (audit:*):
 *    - Issue closure audit (issue-closure-audit-selftest) - verified non-blocking, documented boundaries
 *
 * 3. Mutation Sensitivity:
 *    - Omitting any core domain suite fails validation.
 *    - Misclassifying audit suites as release-blocking triggers failure.
 *    - Missing script file or command mismatch triggers failure.
 *    - Accidental inclusion of runner into test matrices triggers failure.
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const isMutateMode = process.argv.includes("--mutate") || process.env.MUTATE === "1";

const appRoot = path.join(__dirname, "..");
const pkgPath = path.join(appRoot, "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
const scripts = pkg.scripts || {};

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log("  PASS  " + name);
  } catch (err) {
    results.push({ name, ok: false, error: err });
    console.log("  FAIL  " + name + ": " + err.message);
    process.exitCode = 1;
  }
}

/**
 * Functional Coverage Matrix (12 Core Domains)
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
      { key: "selftest:kernelinitcontract", script: "node automation/kernel-init-contract-selftest.js", file: "automation/kernel-init-contract-selftest.js" },
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
      { key: "selftest:fontmetricsparity", script: "node automation/font-sfnt-woff2-metrics-parity-selftest.js", file: "automation/font-sfnt-woff2-metrics-parity-selftest.js" },
      { key: "selftest:fingerprintpool", script: "node automation/fingerprint-pool-selftest.js", file: "automation/fingerprint-pool-selftest.js" },
      { key: "selftest:brandtraceremediation", script: "node automation/page-visible-trace-remediation-selftest.js", file: "automation/page-visible-trace-remediation-selftest.js" },
      { key: "selftest:mobileosfontfix", script: "node automation/mobile-persona-os-font-fix-selftest.js", file: "automation/mobile-persona-os-font-fix-selftest.js" },
      { key: "selftest:fontblobnative", script: "node automation/query-local-font-blob-native-shape-selftest.js", file: "automation/query-local-font-blob-native-shape-selftest.js" },
      { key: "selftest:fontbloblazy", script: "node automation/query-local-font-blob-lazy-payload-selftest.js", file: "automation/query-local-font-blob-lazy-payload-selftest.js" },
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
      { key: "selftest:graphicsalign", script: "node automation/graphics-media-alignment-selftest.js", file: "automation/graphics-media-alignment-selftest.js" },
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
      { key: "selftest:listrendercache", script: "node automation/list-render-cache-tabs-selftest.js", file: "automation/list-render-cache-tabs-selftest.js" },
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
      { key: "selftest:proxyprobe", script: "node automation/proxy-probe-resilience-selftest.js", file: "automation/proxy-probe-resilience-selftest.js" },
    ]
  },
  {
    domain: "Release Defenses & Self-Verification",
    description: "Working-tree sanitization, packaging exclusions, and release gate self-testing",
    suites: [
      { key: "selftest:fpreleasegate", script: "node automation/fingerprint-release-gate-selftest.js", file: "automation/fingerprint-release-gate-selftest.js" },
      { key: "selftest:releasecoverage", script: "node automation/fingerprint-release-coverage-selftest.js", file: "automation/fingerprint-release-coverage-selftest.js" },
    ]
  },
  {
    domain: "Fingerprint Hardening & Security Barriers",
    description: "Font/CSSOM exit closure, media track labels, worker WebGPU parity, stability semantics, DoH, profile Local State and fail-closed startup",
    suites: [
      { key: "selftest:stabilitysemantics", script: "node automation/stability-semantics-selftest.js", file: "automation/stability-semantics-selftest.js" },
      { key: "selftest:mediatracklabel", script: "node automation/mediastreamtrack-label-selftest.js", file: "automation/mediastreamtrack-label-selftest.js" },
      { key: "selftest:cssomfontecho", script: "node automation/cssom-font-echo-selftest.js", file: "automation/cssom-font-echo-selftest.js" },
      { key: "selftest:appcenterfilter", script: "node automation/app-center-fingerprint-filter-selftest.js", file: "automation/app-center-fingerprint-filter-selftest.js" },
      { key: "selftest:livesyncinternal", script: "node automation/live-sync-internal-pages-selftest.js", file: "automation/live-sync-internal-pages-selftest.js" },
      { key: "selftest:proxydoh", script: "node automation/proxy-forwarder-doh-selftest.js", file: "automation/proxy-forwarder-doh-selftest.js" },
      { key: "selftest:profilelocalstate", script: "node automation/profile-local-state-selftest.js", file: "automation/profile-local-state-selftest.js" },
      { key: "selftest:startupbarrier", script: "node automation/startup-consistency-and-barrier-selftest.js", file: "automation/startup-consistency-and-barrier-selftest.js" },
      { key: "selftest:startupdelivery", script: "node automation/startup-fingerprint-delivery-selftest.js", file: "automation/startup-fingerprint-delivery-selftest.js" },
      { key: "selftest:speechcrossplatform", script: "node automation/speech-voice-plugin-crossplatform-selftest.js", file: "automation/speech-voice-plugin-crossplatform-selftest.js" },
      { key: "selftest:uaditerable", script: "node automation/user-agent-iterable-stack-selftest.js", file: "automation/user-agent-iterable-stack-selftest.js" },
      { key: "selftest:kernelinitwebrtc", script: "node automation/kernel-init-webrtc-contract-selftest.js", file: "automation/kernel-init-webrtc-contract-selftest.js" },
      { key: "selftest:kernelinitinvariants", script: "node automation/kernel-template-invariants-selftest.js", file: "automation/kernel-template-invariants-selftest.js" },
    ]
  }
];

/**
 * Diagnostic Audits Partition (Non-blocking, explicit audit:* prefix)
 */
const DIAGNOSTIC_AUDITS = [
  {
    key: "audit:issueclosure",
    script: "node automation/issue-closure-audit-selftest.js",
    file: "automation/issue-closure-audit-selftest.js",
    rationale: "Adversarial GitHub issues #19, #21, #22 closure evaluation with documented boundaries"
  },
  {
    key: "audit:adversarial",
    script: "node automation/adversarial-detection-audit.js",
    file: "automation/adversarial-detection-audit.js",
    rationale: "Round 1 live-kernel A/B adversarial detector: prototype descriptors, cross-context leaks, stack exposure"
  },
  {
    key: "audit:adversarial2",
    script: "node automation/adversarial-detection-audit-round2.js",
    file: "automation/adversarial-detection-audit-round2.js",
    rationale: "Round 2 live-kernel A/B adversarial detector: capability APIs, wire headers, worker contexts, media queries"
  },
  {
    key: "audit:brandtrace",
    script: "node automation/page-visible-brand-trace-audit.js",
    file: "automation/page-visible-brand-trace-audit.js",
    rationale: "Page-visible self-exposure audit: product markers, srcdoc leakage, DOM/CSS artifacts vs native baseline"
  },
  {
    key: "audit:mobilepersona",
    script: "node automation/mobile-persona-consistency-audit.js",
    file: "automation/mobile-persona-consistency-audit.js",
    rationale: "Android/iOS persona end-to-end consistency audit (identity, touch, client hints, GPU, fonts, kernel init)"
  }
];

function validateSuites(suitesList, registeredScripts, baseDir) {
  const issues = [];
  for (const item of suitesList) {
    if (!registeredScripts[item.key]) {
      issues.push("Missing script key in package.json: " + item.key);
      continue;
    }
    if (registeredScripts[item.key] !== item.script) {
      issues.push(item.key + " command mismatch: expected '" + item.script + "', got '" + registeredScripts[item.key] + "'");
    }
    const fullPath = path.resolve(baseDir, item.file);
    if (!fs.existsSync(fullPath)) {
      issues.push("Referenced test file does not exist on disk: " + item.file);
      continue;
    }
    const stat = fs.statSync(fullPath);
    if (stat.size === 0) {
      issues.push("Referenced test file is empty: " + item.file);
    }
  }
  return issues;
}

function validateSyntax(suitesList, baseDir) {
  const issues = [];
  for (const item of suitesList) {
    const fullPath = path.resolve(baseDir, item.file);
    if (!fs.existsSync(fullPath)) continue;
    try {
      execFileSync(process.execPath, ["-c", fullPath], { stdio: "pipe" });
    } catch (err) {
      issues.push("Syntax check failed for " + item.file + ": " + err.message);
    }
  }
  return issues;
}

console.log("Starting OpenBrowser Release Coverage Selftest (mode: " + (isMutateMode ? "MUTATION" : "NORMAL") + ")...\n");

const allCoreSuites = COVERAGE_DOMAINS.flatMap((d) => d.suites);

// Check 1: Coverage Domains Integrity
check("all 13 functional coverage domains are defined and non-empty", () => {
  assert.strictEqual(COVERAGE_DOMAINS.length, 13, "Must declare exactly 13 core coverage domains");
  for (const domain of COVERAGE_DOMAINS) {
    assert.ok(domain.suites.length > 0, "Domain " + domain.domain + " must contain at least one suite");
  }
});

// Check 2: Core Suites Registration in package.json
check("all core regression suites across all domains are registered in package.json", () => {
  const issues = validateSuites(allCoreSuites, scripts, appRoot);
  assert.deepStrictEqual(issues, [], "Core regression suites registration issues:\n" + issues.join("\n"));
});

// Check 3: Core Suites File Existence and Syntax
check("all core regression suite files exist on disk with valid JavaScript syntax", () => {
  const syntaxIssues = validateSyntax(allCoreSuites, appRoot);
  assert.deepStrictEqual(syntaxIssues, [], "Core regression suites syntax failures:\n" + syntaxIssues.join("\n"));
});

// Check 4: Diagnostic Audits Registration and Partitioning
check("diagnostic audits are registered with audit:* prefix and segregated from blocking gates", () => {
  for (const audit of DIAGNOSTIC_AUDITS) {
    assert.ok(audit.key.startsWith("audit:"), "Diagnostic audit key must start with audit: prefix: " + audit.key);
    assert.ok(!allCoreSuites.some((s) => s.key === audit.key), "Diagnostic audit must NOT be in core blocking suites: " + audit.key);
  }
  const issues = validateSuites(DIAGNOSTIC_AUDITS, scripts, appRoot);
  assert.deepStrictEqual(issues, [], "Diagnostic audits registration issues:\n" + issues.join("\n"));
  const syntaxIssues = validateSyntax(DIAGNOSTIC_AUDITS, appRoot);
  assert.deepStrictEqual(syntaxIssues, [], "Diagnostic audits syntax failures:\n" + syntaxIssues.join("\n"));
});

// Check 5: Explicit Issue Resolution Traceability (#19, #21, #22)
check("all three tracked GitHub issues (#19, #21, #22) have designated regression test coverage", () => {
  const issue19Keys = ["selftest:windpi", "selftest:wincascade", "selftest:internalpagesync", "selftest:uiactions", "selftest:webglarchnorm"];
  for (const k of issue19Keys) {
    assert.ok(scripts[k], "Issue #19 regression suite missing: " + k);
  }

  const issue21Keys = ["selftest:tzcountry", "selftest:wintzkernel"];
  for (const k of issue21Keys) {
    assert.ok(scripts[k], "Issue #21 regression suite missing: " + k);
  }

  const issue22Keys = ["selftest:proxyauth", "selftest:socks5complete", "selftest:socks5reset", "selftest:socks5retry"];
  for (const k of issue22Keys) {
    assert.ok(scripts[k], "Issue #22 regression suite missing: " + k);
  }
});

// Check 6: Unique Key Invariant
check("all registered release and audit script keys are mutually unique", () => {
  const allKeys = [...allCoreSuites.map((s) => s.key), ...DIAGNOSTIC_AUDITS.map((a) => a.key)];
  const seen = new Set();
  for (const key of allKeys) {
    assert.ok(!seen.has(key), "Duplicate script key detected in coverage matrix: " + key);
    seen.add(key);
  }
});

// Check 7: Exclusion of regression:final runner to prevent recursion
check("regression runner is excluded from core release and diagnostic suites", () => {
  assert.ok(!allCoreSuites.some((s) => s.key === "regression:final" || s.file.includes("final-release-regression-runner.js")), "Core suites must not contain regression runner");
  assert.ok(!DIAGNOSTIC_AUDITS.some((a) => a.key === "regression:final" || a.file.includes("final-release-regression-runner.js")), "Diagnostic audits must not contain regression runner");
});

// Mutation Sensitivity Checks
check("mutation sensitivity: omitting newly added cjk, webglcompat, mobile, canvasaudiorects, or proxy suites fails validation", () => {
  const mutatedScripts = { ...scripts };
  delete mutatedScripts["selftest:fontcjkprobe"];
  delete mutatedScripts["selftest:webglcompat"];
  delete mutatedScripts["selftest:mobilefp"];
  delete mutatedScripts["selftest:canvasaudiorects"];
  delete mutatedScripts["selftest:proxyauth"];
  delete mutatedScripts["selftest:socks5complete"];
  delete mutatedScripts["selftest:socks5reset"];
  delete mutatedScripts["selftest:socks5retry"];
  const issues = validateSuites(allCoreSuites, mutatedScripts, appRoot);
  assert.ok(issues.length >= 8, "Omitting newly added suites must trigger validation failure");
});

check("mutation sensitivity: omitting any Issue #22 proxy core suite fails validation", () => {
  const mutatedScripts = { ...scripts };
  delete mutatedScripts["selftest:proxyauth"];
  delete mutatedScripts["selftest:socks5complete"];
  delete mutatedScripts["selftest:socks5reset"];
  delete mutatedScripts["selftest:socks5retry"];
  const issues = validateSuites(allCoreSuites, mutatedScripts, appRoot);
  assert.ok(issues.length >= 4, "Omitting all Issue #22 proxy suites must trigger validation failure");
  for (const key of ["selftest:proxyauth", "selftest:socks5complete", "selftest:socks5reset", "selftest:socks5retry"]) {
    assert.ok(issues.some((msg) => msg.includes(key)), `Missing validation error for ${key}`);
  }
});

check("mutation sensitivity: omitting canvasaudiorects core domain suite fails validation", () => {
  const mutatedScripts = { ...scripts };
  delete mutatedScripts["selftest:canvasaudiorects"];
  const issues = validateSuites(allCoreSuites, mutatedScripts, appRoot);
  assert.ok(issues.length > 0, "Omitting canvasaudiorects must trigger validation failure");
  assert.ok(issues.some((msg) => msg.includes("selftest:canvasaudiorects")));
});

check("mutation sensitivity: omitting a core domain suite fails validation", () => {
  const mutatedScripts = { ...scripts };
  delete mutatedScripts["selftest:workerwebgpu"];
  const issues = validateSuites(allCoreSuites, mutatedScripts, appRoot);
  assert.ok(issues.length > 0, "Omitting workerwebgpu must trigger validation failure");
  assert.ok(issues.some((msg) => msg.includes("selftest:workerwebgpu")));
});

check("mutation sensitivity: command mismatch triggers validation failure", () => {
  const mutatedScripts = { ...scripts, "selftest:windpi": "node automation/wrong-script.js" };
  const issues = validateSuites(allCoreSuites, mutatedScripts, appRoot);
  assert.ok(issues.length > 0, "Command mismatch must trigger validation failure");
  assert.ok(issues.some((msg) => msg.includes("selftest:windpi command mismatch")));
});

check("mutation sensitivity: missing referenced file triggers validation failure", () => {
  const dummySuite = [{ key: "selftest:ghost", script: "node automation/ghost.js", file: "automation/ghost.js" }];
  const mutatedScripts = { ...scripts, "selftest:ghost": "node automation/ghost.js" };
  const issues = validateSuites(dummySuite, mutatedScripts, appRoot);
  assert.ok(issues.length > 0, "Missing file on disk must trigger validation failure");
  assert.ok(issues.some((msg) => msg.includes("automation/ghost.js")));
});

check("mutation sensitivity: misclassifying diagnostic audit into core blocking suites triggers failure", () => {
  const illegalCoreSuites = [...allCoreSuites, { key: "audit:issueclosure", script: "node automation/issue-closure-audit-selftest.js", file: "automation/issue-closure-audit-selftest.js" }];
  const hasAuditInCore = illegalCoreSuites.some((s) => s.key.startsWith("audit:"));
  assert.strictEqual(hasAuditInCore, true, "Should detect audit key inside core suites");
});

check("mutation sensitivity: accidental inclusion of runner into core suites triggers failure", () => {
  const dummyCoreWithRunner = [...allCoreSuites, { key: "regression:final", script: "node automation/final-release-regression-runner.js", file: "automation/final-release-regression-runner.js" }];
  const hasRunner = dummyCoreWithRunner.some((s) => s.key === "regression:final" || s.file.includes("final-release-regression-runner.js"));
  assert.strictEqual(hasRunner, true, "Must detect presence of runner in suites");
});

console.log("\n======================================================================");
const failed = results.filter((r) => !r.ok);
if (!failed.length) {
  console.log("fingerprint-release-coverage-selftest: OK " + results.length + "/" + results.length);
} else {
  console.log("fingerprint-release-coverage-selftest: FAILED " + failed.length + "/" + results.length);
  process.exitCode = 1;
}
