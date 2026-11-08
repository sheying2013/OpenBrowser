#!/usr/bin/env node
/**
 * Browserapp/scripts/kernel-track.mjs
 *
 * Local kernel version tracker pipeline for OpenBrowser.
 * Fetches latest stable versions from official Chromium sources and upstream vendors,
 * inspects local repository kernel seeds and configurations,
 * and outputs a comprehensive diff report (human-readable + structured JSON).
 *
 * Features:
 * - Bounded request timeouts & automatic exponential backoff retries.
 * - Local file-based caching with TTL to prevent aggressive querying.
 * - Multi-source tracking: Google Chrome for Testing, ChromiumDash, Wayfern feed.
 * - Local inventory: browser-kernel.js constant, kernels (subdirectories) kernel.json seeds, meta records.
 *
 * CLI options:
 *   --json             Output pure JSON to stdout
 *   --force            Bypass cache and force fresh network queries
 *   --output <file>    Write report JSON to specified file
 *   --ttl <seconds>    Cache validity in seconds (default: 3600 = 1 hour)
 *   --ci               Enable CI mode (isolated temp cache, auto-output to reports/kernel-track/latest.json, baseline drift check)
 *   --baseline <file>  Path to baseline JSON file for drift comparison (default: kernels/meta/kernel-track-baseline.json)
 *   --update-baseline  Update/initialize baseline file with current version state
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const appRoot = path.resolve(__dirname, '..');
const kernelsRoot = path.join(appRoot, 'kernels');
const repoRoot = path.resolve(appRoot, '..');
const defaultCacheFile = path.join(kernelsRoot, 'meta', '.kernel-track-cache.json');
const fallbackCacheFile = path.join(os.tmpdir(), 'openbrowser-kernel-track-cache.json');
const defaultBaselineFile = path.join(kernelsRoot, 'meta', 'kernel-track-baseline.json');
const defaultCiOutputFile = path.join(repoRoot, 'reports', 'kernel-track', 'latest.json');

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_RETRIES = 3;
const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

const SIMULATE_OUTAGE = process.env.TEST_SIMULATE_NETWORK_OUTAGE === '1';

const ENDPOINTS = {
  cft: SIMULATE_OUTAGE ? 'http://127.0.0.1:9/fail-cft' : 'https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions.json',
  chromiumDashMac: SIMULATE_OUTAGE ? 'http://127.0.0.1:9/fail-mac' : 'https://chromiumdash.appspot.com/fetch_releases?channel=Stable&platform=Mac&num=1',
  chromiumDashWin: SIMULATE_OUTAGE ? 'http://127.0.0.1:9/fail-win' : 'https://chromiumdash.appspot.com/fetch_releases?channel=Stable&platform=Windows&num=1',
  chromiumDashLinux: SIMULATE_OUTAGE ? 'http://127.0.0.1:9/fail-linux' : 'https://chromiumdash.appspot.com/fetch_releases?channel=Stable&platform=Linux&num=1',
  wayfern: SIMULATE_OUTAGE ? 'http://127.0.0.1:9/fail-wf' : 'https://donutbrowser.com/wayfern.json',
};

/**
 * Robust fetch with exponential backoff and timeout.
 */
async function fetchWithRetry(url, options = {}, retries = (SIMULATE_OUTAGE ? 1 : DEFAULT_RETRIES), timeoutMs = (SIMULATE_OUTAGE ? 100 : DEFAULT_TIMEOUT_MS)) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const signal = AbortSignal.timeout(timeoutMs);
      const res = await fetch(url, {
        ...options,
        signal,
        headers: {
          'User-Agent': 'OpenBrowser-KernelTracker/1.0',
          ...(options.headers || {}),
        },
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }
      return await res.json();
    } catch (err) {
      lastError = err;
      if (attempt < retries) {
        const delay = Math.pow(2, attempt - 1) * 1000;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError;
}

/**
 * Cache management helpers.
 */
function resolveCachePath(customPath = null) {
  if (customPath) {
    try {
      const metaDir = path.dirname(customPath);
      if (!fs.existsSync(metaDir)) fs.mkdirSync(metaDir, { recursive: true });
      return customPath;
    } catch (_) {
      return fallbackCacheFile;
    }
  }
  try {
    const metaDir = path.dirname(defaultCacheFile);
    if (!fs.existsSync(metaDir)) fs.mkdirSync(metaDir, { recursive: true });
    fs.accessSync(metaDir, fs.constants.W_OK);
    return defaultCacheFile;
  } catch (_) {
    return fallbackCacheFile;
  }
}

/**
 * Baseline path resolver for version drift comparison.
 */
export function resolveBaselinePath(customPath = null) {
  if (customPath) {
    if (path.isAbsolute(customPath)) return customPath;
    const fromCwd = path.resolve(process.cwd(), customPath);
    if (fs.existsSync(fromCwd)) return fromCwd;
    const fromApp = path.resolve(appRoot, customPath);
    if (fs.existsSync(fromApp)) return fromApp;
    const fromRepo = path.resolve(repoRoot, customPath);
    if (fs.existsSync(fromRepo)) return fromRepo;
    return fromCwd;
  }
  if (fs.existsSync(defaultBaselineFile)) return defaultBaselineFile;
  const repoBaseline = path.join(repoRoot, 'kernels', 'meta', 'kernel-track-baseline.json');
  if (fs.existsSync(repoBaseline)) return repoBaseline;
  return defaultBaselineFile;
}

/**
 * Construct baseline data snapshot from current tracking status.
 */
export function createBaselinePayload(report) {
  return {
    version: '1.0.0',
    generatedAt: new Date().toISOString(),
    description: 'OpenBrowser Kernel Tracking Baseline. Used by CI to detect upstream version drift.',
    benchmark: {
      officialStable: report.officialStable || null,
      officialMilestone: report.officialMilestone || null,
      cftStable: report.remote?.cft?.Stable?.version || null,
      wayfernStable: report.remote?.wayfern?.version || null,
      chromiumDash: Object.fromEntries(
        Object.entries(report.remote?.chromiumDash || {}).map(([p, d]) => [p, d.version])
      ),
    },
    local: {
      codeConstant: report.local?.codeConstant || null,
      kernelsMetaWayfern: report.local?.kernelsMetaWayfern || null,
      seeds: Object.fromEntries(
        Object.entries(report.local?.seeds || {}).map(([s, d]) => [s, d.version])
      ),
    },
  };
}

/**
 * Compare current report against recorded baseline data.
 */
export function compareWithBaseline(report, baselineData) {
  const changes = [];
  if (!baselineData || typeof baselineData !== 'object') {
    return { hasDrift: false, changes: [], isInitial: true, summary: 'No valid baseline data provided' };
  }

  const baseBench = baselineData.benchmark || {};
  const baseLocal = baselineData.local || {};

  // 1. Official Chrome Stable
  if (baseBench.officialStable && report.officialStable && baseBench.officialStable !== report.officialStable) {
    const pCurrent = parseVersion(report.officialStable);
    const pBase = parseVersion(baseBench.officialStable);
    const mDelta = pCurrent && pBase ? pCurrent.major - pBase.major : null;
    changes.push({
      type: 'UPSTREAM_CHROME_STABLE',
      target: 'Official Chrome Stable',
      baseline: baseBench.officialStable,
      current: report.officialStable,
      milestoneDelta: mDelta,
      description: `Official Chrome Stable updated: ${baseBench.officialStable} -> ${report.officialStable}`,
    });
  }

  // 2. Upstream Vendor (Wayfern)
  const currentWf = report.remote?.wayfern?.version || null;
  if (baseBench.wayfernStable && currentWf && baseBench.wayfernStable !== currentWf) {
    const pCurrent = parseVersion(currentWf);
    const pBase = parseVersion(baseBench.wayfernStable);
    const mDelta = pCurrent && pBase ? pCurrent.major - pBase.major : null;
    changes.push({
      type: 'UPSTREAM_WAYFERN',
      target: 'Vendor: Wayfern Feed',
      baseline: baseBench.wayfernStable,
      current: currentWf,
      milestoneDelta: mDelta,
      description: `Wayfern upstream release updated: ${baseBench.wayfernStable} -> ${currentWf}`,
    });
  }

  // 3. Local Code Constant
  if (baseLocal.codeConstant && report.local?.codeConstant && baseLocal.codeConstant !== report.local.codeConstant) {
    changes.push({
      type: 'LOCAL_CONSTANT',
      target: 'Code Constant (browser-kernel.js)',
      baseline: baseLocal.codeConstant,
      current: report.local.codeConstant,
      milestoneDelta: null,
      description: `Local code constant changed: ${baseLocal.codeConstant} -> ${report.local.codeConstant}`,
    });
  }

  // 4. Local Seeds
  if (baseLocal.seeds && report.local?.seeds) {
    for (const [seedName, seedInfo] of Object.entries(report.local.seeds)) {
      const baseSeedVer = baseLocal.seeds[seedName];
      if (baseSeedVer && seedInfo.version && baseSeedVer !== seedInfo.version) {
        changes.push({
          type: 'LOCAL_SEED',
          target: `Seed: ${seedName}`,
          baseline: baseSeedVer,
          current: seedInfo.version,
          milestoneDelta: null,
          description: `Seed ${seedName} changed: ${baseSeedVer} -> ${seedInfo.version}`,
        });
      }
    }
  }

  const hasDrift = changes.length > 0;
  const summary = hasDrift
    ? `Drift detected: ${changes.length} version change(s) against baseline`
    : 'No drift: All tracked upstream & local versions match baseline';

  return {
    hasDrift,
    changes,
    isInitial: false,
    summary,
  };
}

async function loadCache(cachePath, ttlMs) {
  try {
    const raw = await fsp.readFile(cachePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && parsed.timestamp && (Date.now() - parsed.timestamp) < ttlMs) {
      return parsed.data;
    }
  } catch (_) {}
  return null;
}

async function saveCache(cachePath, data) {
  try {
    const payload = JSON.stringify({ timestamp: Date.now(), data }, null, 2);
    await fsp.writeFile(cachePath, payload, 'utf8');
  } catch (_) {}
}

/**
 * Semantic/Milestone version comparison.
 */
function parseVersion(vStr) {
  if (!vStr || typeof vStr !== 'string') return null;
  const parts = vStr.trim().split('.').map((p) => parseInt(p, 10));
  if (parts.some(isNaN)) return null;
  return {
    major: parts[0] || 0,
    minor: parts[1] || 0,
    build: parts[2] || 0,
    patch: parts[3] || 0,
    raw: vStr.trim(),
  };
}

function compareVersions(vA, vB) {
  const pA = parseVersion(vA);
  const pB = parseVersion(vB);
  if (!pA || !pB) return null;
  if (pA.major !== pB.major) return pA.major - pB.major;
  if (pA.minor !== pB.minor) return pA.minor - pB.minor;
  if (pA.build !== pB.build) return pA.build - pB.build;
  return pA.patch - pB.patch;
}

/**
 * Inventory local repository kernel definitions.
 */
async function inspectLocalKernels() {
  const local = {
    codeConstant: null,
    kernelsMetaWayfern: null,
    seeds: {},
  };

  // 1. Read constant from Browserapp/automation/browser-kernel.js
  try {
    const code = await fsp.readFile(path.join(appRoot, 'automation', 'browser-kernel.js'), 'utf8');
    const m = code.match(/const\s+OPENBROWSER_KERNEL_VERSION\s*=\s*['"]([^'"]+)['"]/);
    if (m) local.codeConstant = m[1];
  } catch (_) {}

  // 2. Read kernels/meta/wayfern.json
  try {
    const wfRaw = await fsp.readFile(path.join(kernelsRoot, 'meta', 'wayfern.json'), 'utf8');
    const wf = JSON.parse(wfRaw);
    if (wf?.version) local.kernelsMetaWayfern = wf.version;
  } catch (_) {}

  // 3. Scan kernels/*/kernel.json
  const candidateDirs = ['macos-x64', 'windows-x64', 'macos-arm64', 'chrome-stable'];
  for (const dir of candidateDirs) {
    const kPath = path.join(kernelsRoot, dir, 'kernel.json');
    try {
      if (fs.existsSync(kPath)) {
        const kData = JSON.parse(await fsp.readFile(kPath, 'utf8'));
        local.seeds[dir] = {
          version: kData.version || null,
          platform: kData.platform || dir,
          binary: kData.binary || null,
        };
      }
    } catch (_) {}
  }

  return local;
}

/**
 * Fetch remote kernel versions with caching and fallback.
 */
async function fetchRemoteVersions(force = false, ttlMs = DEFAULT_CACHE_TTL_MS, customCachePath = null) {
  const cachePath = resolveCachePath(customCachePath);
  if (!force) {
    const cached = await loadCache(cachePath, ttlMs);
    if (cached) return { data: cached, fromCache: true, cachePath };
  }

  const results = {
    cft: null,
    chromiumDash: {},
    wayfern: null,
    errors: {},
  };

  // Query CfT
  try {
    results.cft = await fetchWithRetry(ENDPOINTS.cft);
  } catch (err) {
    results.errors.cft = err.message;
  }

  // Query ChromiumDash per platform
  const dashQueries = [
    ['Mac', ENDPOINTS.chromiumDashMac],
    ['Windows', ENDPOINTS.chromiumDashWin],
    ['Linux', ENDPOINTS.chromiumDashLinux],
  ];
  await Promise.allSettled(dashQueries.map(async ([plat, url]) => {
    try {
      const data = await fetchWithRetry(url);
      if (Array.isArray(data) && data[0]) {
        results.chromiumDash[plat] = {
          version: data[0].version,
          milestone: data[0].milestone,
          channel: data[0].channel,
        };
      }
    } catch (err) {
      results.errors[`chromiumDash_${plat}`] = err.message;
    }
  }));

  // Query Wayfern upstream vendor feed
  try {
    results.wayfern = await fetchWithRetry(ENDPOINTS.wayfern);
  } catch (err) {
    results.errors.wayfern = err.message;
  }

  await saveCache(cachePath, results);
  return { data: results, fromCache: false, cachePath };
}

/**
 * Generate full diff and risk analysis.
 */
export async function trackKernelVersions(options = {}) {
  const {
    force = false,
    ttlMs = DEFAULT_CACHE_TTL_MS,
    ci = false,
    baseline = null,
    updateBaseline = false,
    outputFile = null,
  } = options;

  // In CI environment: bypass repository cache and use temporary directory cache
  const effectiveCachePath = ci ? fallbackCacheFile : resolveCachePath();
  const effectiveForce = ci ? true : force;

  const local = await inspectLocalKernels();
  const { data: remote, fromCache, cachePath } = await fetchRemoteVersions(effectiveForce, ttlMs, effectiveCachePath);

  // Extract reference targets
  const cftStable = remote.cft?.channels?.Stable?.version || null;
  const dashMacStable = remote.chromiumDash?.Mac?.version || null;
  const dashWinStable = remote.chromiumDash?.Windows?.version || null;
  const wayfernStable = remote.wayfern?.version || null;

  // Primary upstream reference is Chrome Stable (from CfT or Dash)
  const officialStable = cftStable || dashMacStable || dashWinStable;
  const officialMilestone = parseVersion(officialStable)?.major || null;

  // Build comparisons
  const diffs = [];

  // Compare Code Constant
  if (local.codeConstant && officialStable) {
    const lParsed = parseVersion(local.codeConstant);
    const rParsed = parseVersion(officialStable);
    const deltaMilestones = lParsed && rParsed ? (lParsed.major - rParsed.major) : null;
    diffs.push({
      component: 'Code Constant (browser-kernel.js)',
      localVersion: local.codeConstant,
      remoteVersion: officialStable,
      milestoneDelta: deltaMilestones,
      status: deltaMilestones === 0 ? 'UP_TO_DATE' : (deltaMilestones < 0 ? 'BEHIND' : 'AHEAD'),
      risk: Math.abs(deltaMilestones || 0) >= 4 ? 'HIGH' : (Math.abs(deltaMilestones || 0) > 0 ? 'MEDIUM' : 'LOW'),
    });
  }

  // Compare Seeds
  for (const [seedName, seedInfo] of Object.entries(local.seeds)) {
    if (seedInfo.version && officialStable) {
      const lParsed = parseVersion(seedInfo.version);
      const rParsed = parseVersion(officialStable);
      const deltaMilestones = lParsed && rParsed ? (lParsed.major - rParsed.major) : null;
      diffs.push({
        component: `Seed: ${seedName}`,
        localVersion: seedInfo.version,
        remoteVersion: officialStable,
        milestoneDelta: deltaMilestones,
        status: deltaMilestones === 0 ? 'UP_TO_DATE' : (deltaMilestones < 0 ? 'BEHIND' : 'AHEAD'),
        risk: Math.abs(deltaMilestones || 0) >= 4 ? 'HIGH' : (Math.abs(deltaMilestones || 0) > 0 ? 'MEDIUM' : 'LOW'),
      });
    }
  }

  // Compare Wayfern local vs remote
  if (local.kernelsMetaWayfern && wayfernStable) {
    const lParsed = parseVersion(local.kernelsMetaWayfern);
    const rParsed = parseVersion(wayfernStable);
    const deltaMilestones = lParsed && rParsed ? (lParsed.major - rParsed.major) : null;
    diffs.push({
      component: 'Vendor: Wayfern Seed vs Remote Feed',
      localVersion: local.kernelsMetaWayfern,
      remoteVersion: wayfernStable,
      milestoneDelta: deltaMilestones,
      status: deltaMilestones === 0 ? 'UP_TO_DATE' : (deltaMilestones < 0 ? 'BEHIND' : 'AHEAD'),
      risk: Math.abs(deltaMilestones || 0) >= 2 ? 'MEDIUM' : 'LOW',
    });
  }

  const networkError = Boolean(!officialStable && remote.errors && Object.keys(remote.errors).length > 0);

  const report = {
    timestamp: new Date().toISOString(),
    fromCache,
    cachePath,
    officialStable,
    officialMilestone,
    remote: {
      cft: remote.cft?.channels || null,
      chromiumDash: remote.chromiumDash || null,
      wayfern: remote.wayfern ? { version: remote.wayfern.version, downloads: remote.wayfern.downloads } : null,
      errors: Object.keys(remote.errors || {}).length ? remote.errors : null,
    },
    local,
    diffs,
    ci: {
      enabled: Boolean(ci),
      outputFile: outputFile || (ci ? defaultCiOutputFile : null),
      networkError,
    },
  };

  // Evaluate baseline drift if CI or baseline requested
  let baselinePath = null;
  let baselineData = null;
  let baselineDrift = null;

  if (ci || baseline !== null || updateBaseline) {
    baselinePath = resolveBaselinePath(baseline);
    try {
      if (fs.existsSync(baselinePath) && !updateBaseline) {
        const raw = await fsp.readFile(baselinePath, 'utf8');
        baselineData = JSON.parse(raw);
        baselineDrift = compareWithBaseline(report, baselineData);
      } else {
        // Generate or update baseline snapshot
        const generated = createBaselinePayload(report);
        const metaDir = path.dirname(baselinePath);
        if (!fs.existsSync(metaDir)) await fsp.mkdir(metaDir, { recursive: true });
        await fsp.writeFile(baselinePath, JSON.stringify(generated, null, 2), 'utf8');
        baselineData = generated;
        baselineDrift = {
          hasDrift: false,
          changes: [],
          isInitial: true,
          summary: `Baseline ${updateBaseline ? 'updated' : 'initialized'} at ${baselinePath}`,
        };
      }
    } catch (err) {
      baselineDrift = {
        hasDrift: false,
        changes: [],
        error: err.message,
        summary: `Baseline processing error: ${err.message}`,
      };
    }

    report.baseline = {
      path: baselinePath,
      exists: Boolean(baselineData),
      data: baselineData,
    };
    report.baselineDrift = baselineDrift;
  }

  return report;
}

/**
 * Format human-readable CLI report.
 */
function formatHumanReport(report) {
  const lines = [];
  lines.push('========================================================================');
  lines.push('              OpenBrowser Kernel Version Tracking Report                ');
  lines.push('========================================================================');
  lines.push(`Generated: ${report.timestamp}`);
  lines.push(`Cache status: ${report.fromCache ? 'HIT (serving cached data)' : 'MISS (fresh network fetch)'}`);
  lines.push(`Cache location: ${report.cachePath}`);
  lines.push('');

  lines.push('--- [1] Remote Chromium Release Feeds ---');
  if (report.remote.cft) {
    const s = report.remote.cft.Stable;
    const b = report.remote.cft.Beta;
    const d = report.remote.cft.Dev;
    const c = report.remote.cft.Canary;
    lines.push(`  Chrome for Testing:`);
    lines.push(`    Stable: ${s?.version || 'N/A'} (r${s?.revision || 'N/A'})`);
    lines.push(`    Beta:   ${b?.version || 'N/A'} (r${b?.revision || 'N/A'})`);
    lines.push(`    Dev:    ${d?.version || 'N/A'} (r${d?.revision || 'N/A'})`);
    lines.push(`    Canary: ${c?.version || 'N/A'} (r${c?.revision || 'N/A'})`);
  }
  if (report.remote.chromiumDash && Object.keys(report.remote.chromiumDash).length) {
    lines.push(`  ChromiumDash Stable:`);
    for (const [p, d] of Object.entries(report.remote.chromiumDash)) {
      lines.push(`    ${p.padEnd(8)}: ${d.version} (M${d.milestone})`);
    }
  }
  if (report.remote.wayfern) {
    lines.push(`  Upstream Vendor (Wayfern):`);
    lines.push(`    Latest Version: ${report.remote.wayfern.version}`);
  }
  if (report.remote.errors) {
    lines.push(`  Warnings/Errors in remote queries:`);
    for (const [k, e] of Object.entries(report.remote.errors)) {
      lines.push(`    - ${k}: ${e}`);
    }
  }
  lines.push('');

  lines.push('--- [2] Local Repository Kernel Inventory ---');
  lines.push(`  Codebase Constant (OPENBROWSER_KERNEL_VERSION): ${report.local.codeConstant || 'not detected'}`);
  lines.push(`  Vendor Meta (kernels/meta/wayfern.json):         ${report.local.kernelsMetaWayfern || 'not detected'}`);
  lines.push(`  Integrated Seeds:`);
  for (const [dir, item] of Object.entries(report.local.seeds)) {
    lines.push(`    ${dir.padEnd(16)}: ${item.version || 'unversioned'} (${item.binary || 'binary'})`);
  }
  lines.push('');

  lines.push('--- [3] Discrepancy & Risk Matrix ---');
  lines.push(`  Official Stable Benchmark: ${report.officialStable || 'N/A'} (M${report.officialMilestone || '?'})`);
  lines.push('');
  lines.push('  ' + 'Target Component'.padEnd(38) + 'Local'.padEnd(16) + 'Remote'.padEnd(16) + 'Delta'.padEnd(8) + 'Risk');
  lines.push('  ' + '-'.repeat(84));
  for (const d of report.diffs) {
    const deltaStr = d.milestoneDelta === 0 ? '0' : (d.milestoneDelta > 0 ? `+${d.milestoneDelta}` : `${d.milestoneDelta}`);
    lines.push(`  ${d.component.padEnd(38)}${String(d.localVersion).padEnd(16)}${String(d.remoteVersion).padEnd(16)}${deltaStr.padEnd(8)}${d.risk}`);
  }
  lines.push('');

  if (report.baselineDrift) {
    lines.push('--- [4] Baseline Drift Evaluation ---');
    lines.push(`  Baseline File: ${report.baseline?.path || 'N/A'}`);
    lines.push(`  Status:        ${report.baselineDrift.hasDrift ? 'DRIFT DETECTED (New Upstream Releases / Drift)' : 'IN SYNC (Matches Baseline)'}`);
    lines.push(`  Summary:       ${report.baselineDrift.summary}`);
    if (report.baselineDrift.changes && report.baselineDrift.changes.length > 0) {
      lines.push('  Detected Changes:');
      for (const ch of report.baselineDrift.changes) {
        lines.push(`    - [${ch.type}] ${ch.target}: ${ch.baseline || 'none'} -> ${ch.current} (${ch.description})`);
      }
    }
    lines.push('');
  }

  lines.push('--- [5] Architectural Assessment ---');
  const maxLag = Math.min(...report.diffs.map((d) => d.milestoneDelta || 0));
  if (maxLag <= -4) {
    lines.push(`  [ALERT] Local kernel lag is significant (${maxLag} major versions behind official Stable).`);
    lines.push('  Detection vectors (BotGuard, DataDome, Cloudflare) may flag User-Agent / BoringSSL TLS discrepancies.');
    lines.push('  Recommendation: Schedule scheduled kernel sync via GitHub Actions and prepare updated Wayfern seed.');
  } else if (maxLag < 0) {
    lines.push(`  [NOTICE] Local kernel is ${Math.abs(maxLag)} milestone(s) behind current Stable. Normal release gap.`);
  } else {
    lines.push('  [OK] Local kernel version aligns with official Stable.');
  }
  lines.push('========================================================================\n');
  return lines.join('\n');
}

/**
 * Format markdown report summary suitable for GitHub Step Summary.
 */
export function formatMarkdownSummary(report) {
  const lines = [];
  const isNetworkFailure = Boolean(report.ci?.networkError || (!report.officialStable && report.remote?.errors && Object.keys(report.remote.errors).length > 0));

  if (isNetworkFailure) {
    lines.push('## ⚠️ OpenBrowser Kernel Version Tracker: Network Outage Alert');
    lines.push('');
    lines.push('> **CRITICAL**: Failed to reach any remote Chromium release feeds due to network timeout or connection errors.');
    lines.push('');
    lines.push('### ❌ Remote Feed Errors');
    for (const [k, e] of Object.entries(report.remote?.errors || {})) {
      lines.push(`- **${k}**: \`${e}\``);
    }
    lines.push('');
  } else {
    lines.push('## 🌐 OpenBrowser Kernel Version Tracking Summary');
    lines.push('');
  }

  lines.push(`- **Timestamp**: \`${report.timestamp}\``);
  lines.push(`- **Official Chrome Stable**: \`${report.officialStable || 'N/A'}\` (M${report.officialMilestone || '?'})`);
  lines.push(`- **Local Built-in Version**: \`${report.local?.codeConstant || 'N/A'}\``);
  if (report.remote?.wayfern?.version) {
    lines.push(`- **Upstream Wayfern Feed**: \`${report.remote.wayfern.version}\``);
  }
  lines.push('');

  if (report.baselineDrift) {
    if (report.baselineDrift.hasDrift) {
      lines.push('### 🚨 Baseline Drift Detected');
      lines.push('');
      lines.push('| Target | Baseline Version | Current Version | Milestone Delta | Details |');
      lines.push('|---|---|---|---|---|');
      for (const ch of report.baselineDrift.changes) {
        const deltaStr = ch.milestoneDelta !== undefined && ch.milestoneDelta !== null
          ? (ch.milestoneDelta > 0 ? `+${ch.milestoneDelta}` : `${ch.milestoneDelta}`)
          : '-';
        lines.push(`| ${ch.target} | \`${ch.baseline}\` | \`${ch.current}\` | ${deltaStr} | ${ch.description} |`);
      }
      lines.push('');
    } else {
      lines.push('### ✅ Baseline Drift Check: In Sync');
      lines.push(`*${report.baselineDrift.summary}*`);
      lines.push('');
    }
  }

  lines.push('### 📊 Discrepancy & Risk Matrix');
  lines.push('');
  lines.push('| Component | Local Version | Remote Benchmark | Delta (Milestones) | Risk Level |');
  lines.push('|---|---|---|---|---|');
  for (const d of report.diffs || []) {
    const deltaStr = d.milestoneDelta === 0 ? '0' : (d.milestoneDelta > 0 ? `+${d.milestoneDelta}` : `${d.milestoneDelta}`);
    lines.push(`| ${d.component} | \`${d.localVersion}\` | \`${d.remoteVersion}\` | ${deltaStr} | **${d.risk}** |`);
  }
  lines.push('');

  return lines.join('\n');
}

/**
 * Format markdown issue body for GitHub Actions automated alerting.
 */
export function formatIssueBody(report) {
  const lines = [];
  lines.push('## 🚨 OpenBrowser 内核版本漂移通知 (Kernel Version Drift)');
  lines.push('');
  lines.push('> 自动化检测发现 Chromium 官方发布源或上游厂商 Wayfern 存在新版本，或本地内核配置与已登记基线发生漂移。');
  lines.push('');
  lines.push(`- **检测时间**：\`${report.timestamp}\``);
  lines.push(`- **官方 Chrome Stable 基准**：\`${report.officialStable || 'N/A'}\` (M${report.officialMilestone || '?'})`);
  lines.push(`- **本地主要内置版本**：\`${report.local?.codeConstant || 'N/A'}\``);
  if (report.remote?.wayfern?.version) {
    lines.push(`- **上游 Wayfern 最新版本**：\`${report.remote.wayfern.version}\``);
  }
  lines.push('');

  if (report.baselineDrift?.changes?.length) {
    lines.push('### 🔄 基线对比变更详情');
    lines.push('');
    lines.push('| 目标组件 | 基线记录版本 | 当前检测版本 | 里程碑差 | 变更说明 |');
    lines.push('|---|---|---|---|---|');
    for (const ch of report.baselineDrift.changes) {
      const deltaStr = ch.milestoneDelta !== undefined && ch.milestoneDelta !== null
        ? (ch.milestoneDelta > 0 ? `+${ch.milestoneDelta}` : `${ch.milestoneDelta}`)
        : '-';
      lines.push(`| ${ch.target} | \`${ch.baseline}\` | \`${ch.current}\` | ${deltaStr} | ${ch.description} |`);
    }
    lines.push('');
  }

  lines.push('### 📊 当前各组件落后矩阵');
  lines.push('');
  lines.push('| 目标组件 | 本地版本 | 官方最新 | 差距 (Milestones) | 风险等级 |');
  lines.push('|---|---|---|---|---|');
  for (const d of report.diffs || []) {
    const deltaStr = d.milestoneDelta === 0 ? '0' : (d.milestoneDelta > 0 ? `+${d.milestoneDelta}` : `${d.milestoneDelta}`);
    lines.push(`| ${d.component} | \`${d.localVersion}\` | \`${d.remoteVersion}\` | ${deltaStr} | **${d.risk}** |`);
  }
  lines.push('');

  lines.push('### 🛠️ 处置建议与安全原则');
  lines.push('1. **保持人工升级门禁**：严禁全自动无人值守替换生产内核。升级需经过 `libskit` 钩子、CDP 注入与反指纹测试。');
  lines.push('2. **评估版本对齐**：核验 `Browserapp/automation/fingerprint.js` 中的 User-Agent 与 Client Hints 生成区间，避免指纹特征早于或远落后内核。');
  lines.push('3. **核对独立内核构建**：确认上游 Wayfern 是否已提供对应平台架构的独立内核。');
  lines.push('4. **更新基线**：如确认本次变更已处理或接受，可更新 `kernels/meta/kernel-track-baseline.json` 消除本告警。');
  lines.push('');
  lines.push('---');
  lines.push(`*Generated by OpenBrowser Kernel Tracker CI pipeline (commit: ${process.env.GITHUB_SHA || 'local'})*`);
  return lines.join('\n');
}

/**
 * Main CLI entrypoint.
 */
async function main() {
  const args = process.argv.slice(2);
  const jsonMode = args.includes('--json');
  const force = args.includes('--force') || args.includes('--no-cache');
  const ciMode = args.includes('--ci');
  const updateBaseline = args.includes('--update-baseline');

  let baselineFile = null;
  const baseIdx = args.indexOf('--baseline');
  if (baseIdx !== -1 && args[baseIdx + 1]) {
    baselineFile = args[baseIdx + 1];
  }

  let outputFile = null;
  const outIdx = args.indexOf('--output');
  if (outIdx !== -1 && args[outIdx + 1]) {
    outputFile = path.resolve(args[outIdx + 1]);
  } else if (ciMode) {
    outputFile = defaultCiOutputFile;
  }

  let ttlMs = DEFAULT_CACHE_TTL_MS;
  const ttlIdx = args.indexOf('--ttl');
  if (ttlIdx !== -1 && args[ttlIdx + 1]) {
    ttlMs = (parseInt(args[ttlIdx + 1], 10) || 3600) * 1000;
  }

  const report = await trackKernelVersions({
    force,
    ttlMs,
    ci: ciMode,
    baseline: baselineFile,
    updateBaseline,
    outputFile,
  });

  if (outputFile) {
    const outDir = path.dirname(outputFile);
    if (!fs.existsSync(outDir)) {
      await fsp.mkdir(outDir, { recursive: true });
    }
    await fsp.writeFile(outputFile, JSON.stringify(report, null, 2), 'utf8');
  }

  if (ciMode) {
    const isNetworkError = Boolean(report.ci?.networkError || (!report.officialStable && report.remote?.errors && Object.keys(report.remote.errors).length > 0));

    // Write GitHub Actions environment outputs if in Actions runner
    if (process.env.GITHUB_OUTPUT) {
      try {
        const hasDrift = Boolean(report.baselineDrift?.hasDrift);
        const driftCount = report.baselineDrift?.changes?.length || 0;
        const driftSummary = (report.baselineDrift?.summary || '').replace(/\r?\n/g, ' ');
        const outLines = [
          `has_drift=${hasDrift}`,
          `drift_count=${driftCount}`,
          `official_stable=${report.officialStable || ''}`,
          `official_milestone=${report.officialMilestone || ''}`,
          `wayfern_stable=${report.remote?.wayfern?.version || ''}`,
          `drift_summary=${driftSummary}`,
          `report_path=${outputFile || ''}`,
          `network_error=${isNetworkError}`,
        ];
        await fsp.appendFile(process.env.GITHUB_OUTPUT, outLines.join('\n') + '\n', 'utf8');
      } catch (_) {}
    }

    // Write GitHub Step Summary if available
    if (process.env.GITHUB_STEP_SUMMARY) {
      try {
        const summaryMd = formatMarkdownSummary(report);
        await fsp.appendFile(process.env.GITHUB_STEP_SUMMARY, summaryMd + '\n', 'utf8');
      } catch (_) {}
    }

    // Also write issue body payload file next to latest.json for gh cli consumption (only when report resolved valid stable)
    if (outputFile && !isNetworkError) {
      try {
        const issueBodyFile = path.join(path.dirname(outputFile), 'issue-body.md');
        const issueMd = formatIssueBody(report);
        await fsp.writeFile(issueBodyFile, issueMd, 'utf8');
      } catch (_) {}
    }

    if (isNetworkError) {
      console.error('\n[kernel-track:ci] FATAL NETWORK ERROR: Failed to resolve any official remote Chromium release feeds.');
      console.error('[kernel-track:ci] Remote query errors:');
      for (const [k, e] of Object.entries(report.remote?.errors || {})) {
        console.error(`  - ${k}: ${e}`);
      }
      console.error('[kernel-track:ci] Exiting with non-zero exit code (2) to trigger CI failure and maintainer alert.\n');
      process.exit(2);
    }
  }

  if (jsonMode) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatHumanReport(report));
    if (outputFile) {
      console.log(`[kernel-track] Full JSON report written to: ${outputFile}\n`);
    }
    if (ciMode && report.baselineDrift) {
      console.log(`[kernel-track:ci] Baseline drift status: ${report.baselineDrift.hasDrift ? 'DRIFT DETECTED' : 'IN_SYNC'}`);
      console.log(`[kernel-track:ci] Summary: ${report.baselineDrift.summary}\n`);
    }
  }
}

// Auto-run if executed directly
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main().catch((err) => {
    console.error('[kernel-track] Fatal execution error:', err);
    process.exit(1);
  });
}
