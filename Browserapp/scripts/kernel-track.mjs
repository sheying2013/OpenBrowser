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
const defaultCacheFile = path.join(kernelsRoot, 'meta', '.kernel-track-cache.json');
const fallbackCacheFile = path.join(os.tmpdir(), 'openbrowser-kernel-track-cache.json');

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_RETRIES = 3;
const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

const ENDPOINTS = {
  cft: 'https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions.json',
  chromiumDashMac: 'https://chromiumdash.appspot.com/fetch_releases?channel=Stable&platform=Mac&num=1',
  chromiumDashWin: 'https://chromiumdash.appspot.com/fetch_releases?channel=Stable&platform=Windows&num=1',
  chromiumDashLinux: 'https://chromiumdash.appspot.com/fetch_releases?channel=Stable&platform=Linux&num=1',
  wayfern: 'https://donutbrowser.com/wayfern.json',
};

/**
 * Robust fetch with exponential backoff and timeout.
 */
async function fetchWithRetry(url, options = {}, retries = DEFAULT_RETRIES, timeoutMs = DEFAULT_TIMEOUT_MS) {
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
function resolveCachePath() {
  try {
    const metaDir = path.dirname(defaultCacheFile);
    if (!fs.existsSync(metaDir)) fs.mkdirSync(metaDir, { recursive: true });
    fs.accessSync(metaDir, fs.constants.W_OK);
    return defaultCacheFile;
  } catch (_) {
    return fallbackCacheFile;
  }
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
async function fetchRemoteVersions(force = false, ttlMs = DEFAULT_CACHE_TTL_MS) {
  const cachePath = resolveCachePath();
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
  const { force = false, ttlMs = DEFAULT_CACHE_TTL_MS } = options;
  const local = await inspectLocalKernels();
  const { data: remote, fromCache, cachePath } = await fetchRemoteVersions(force, ttlMs);

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

  return {
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
  };
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

  lines.push('--- [4] Architectural Assessment ---');
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
 * Main CLI entrypoint.
 */
async function main() {
  const args = process.argv.slice(2);
  const jsonMode = args.includes('--json');
  const force = args.includes('--force') || args.includes('--no-cache');
  let outputFile = null;
  const outIdx = args.indexOf('--output');
  if (outIdx !== -1 && args[outIdx + 1]) {
    outputFile = path.resolve(args[outIdx + 1]);
  }
  let ttlMs = DEFAULT_CACHE_TTL_MS;
  const ttlIdx = args.indexOf('--ttl');
  if (ttlIdx !== -1 && args[ttlIdx + 1]) {
    ttlMs = (parseInt(args[ttlIdx + 1], 10) || 3600) * 1000;
  }

  const report = await trackKernelVersions({ force, ttlMs });

  if (outputFile) {
    await fsp.writeFile(outputFile, JSON.stringify(report, null, 2), 'utf8');
  }

  if (jsonMode) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatHumanReport(report));
    if (outputFile) {
      console.log(`[kernel-track] Full JSON report written to: ${outputFile}\n`);
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
