'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

/**
 * Multi-open isolation helpers (profile data dirs, locks, audits).
 * Goal: one environment = one user-data-dir = no cookie/storage bleed.
 */

function lockPath(profileRoot) {
  return path.join(profileRoot, '.openbrowser-instance.lock');
}

async function acquireProfileLock(profileRoot, meta = {}) {
  await fsp.mkdir(profileRoot, { recursive: true });
  const file = lockPath(profileRoot);
  const guard = file + '.guard';
  const guardPayload = { pid: process.pid, createdAt: new Date().toISOString() };
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fsp.mkdir(guard);
      await fsp.writeFile(path.join(guard, 'owner.json'), JSON.stringify(guardPayload), 'utf8');
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let owner = null;
      try { owner = JSON.parse(await fsp.readFile(path.join(guard, 'owner.json'), 'utf8')); } catch (_) {}
      if (owner?.pid && !isPidAlive(owner.pid)) {
        await fsp.rm(guard, { recursive: true, force: true }).catch(() => {});
        continue;
      }
      if (attempt >= 100) throw new Error('Timed out acquiring profile lock guard');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  try {
    let existing = null;
    try { existing = JSON.parse(await fsp.readFile(file, 'utf8')); } catch (_) {}
    if (existing?.pid && isPidAlive(existing.pid)) {
      const err = new Error(`Profile already running (pid ${existing.pid})`);
      err.code = 'PROFILE_LOCKED';
      err.lock = existing;
      throw err;
    }
    if (existing || fs.existsSync(file)) await fsp.rm(file, { force: true });

    const payload = {
      ...meta,
      pid: process.pid,
      token: crypto.randomBytes(24).toString('hex'),
      createdAt: new Date().toISOString(),
    };
    const handle = await fsp.open(file, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(payload, null, 2), 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    return payload;
  } finally {
    await fsp.rm(guard, { recursive: true, force: true }).catch(() => {});
  }
}

async function releaseProfileLock(profileRoot, owner = null) {
  const file = lockPath(profileRoot);
  if (!owner?.token) return false;
  let existing;
  try { existing = JSON.parse(await fsp.readFile(file, 'utf8')); } catch (_) { return false; }
  if (existing.pid !== owner.pid || existing.token !== owner.token) return false;
  await fsp.rm(file, { force: true });
  return true;
}

function isPidAlive(pid) {
  const numeric = Number(pid);
  if (!Number.isSafeInteger(numeric) || numeric <= 0) return false;
  try {
    process.kill(numeric, 0);
    return true;
  } catch (error) {
    // Windows/Linux: process exists but we cannot signal it (different session / elevation).
    // Treat as alive so we never steal a live profile lock.
    if (error && (error.code === 'EPERM' || error.code === 'EACCES')) return true;
    return false;
  }
}

function normalizedPath(value) {
  const resolved = path.resolve(String(value || ''));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isPathInsideOrEqual(candidate, parent) {
  const child = normalizedPath(candidate);
  const base = normalizedPath(parent);
  return child === base || child.startsWith(base + path.sep);
}

function isValidProfileId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

function assertProfileId(value) {
  if (!isValidProfileId(value)) throw new Error('Invalid profile id');
  return value;
}

function realPathOrResolved(value) {
  const resolved = path.resolve(String(value || ''));
  try { return fs.realpathSync.native(resolved); } catch (_) { return resolved; }
}

function isLinkLike(value) {
  try { return fs.lstatSync(value).isSymbolicLink(); } catch (_) { return false; }
}

/**
 * Known browser data roots must never be selected as OpenBrowser storage.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [home]
 * @param {string} [platform] optional override for selftests (darwin|win32|linux)
 */
function systemBrowserDataRoots(env = process.env, home = require('os').homedir(), platform = process.platform) {
  env = env || process.env;
  home = home || require('os').homedir();
  const plat = platform || process.platform;
  if (plat === 'darwin') {
    return [
      path.join(home, 'Library', 'Application Support', 'Google', 'Chrome'),
      path.join(home, 'Library', 'Application Support', 'Google', 'Chrome for Testing'),
      path.join(home, 'Library', 'Application Support', 'Microsoft Edge'),
      path.join(home, 'Library', 'Application Support', 'Chromium'),
      path.join(home, 'Library', 'Application Support', 'BraveSoftware', 'Brave-Browser'),
      path.join(home, 'Library', 'Application Support', 'Vivaldi'),
    ];
  }
  if (plat === 'win32') {
    // Chrome/Chromium family stores User Data under Local AppData, not Roaming.
    // Using APPDATA (Roaming) would miss the real profile tree and allow false-ok isolation.
    const localAppData = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const appData = env.APPDATA || path.join(home, 'AppData', 'Roaming');
    return [
      path.join(localAppData, 'Google', 'Chrome', 'User Data'),
      path.join(localAppData, 'Google', 'Chrome for Testing', 'User Data'),
      path.join(localAppData, 'Google', 'Chrome Beta', 'User Data'),
      path.join(localAppData, 'Google', 'Chrome SxS', 'User Data'),
      path.join(localAppData, 'Microsoft', 'Edge', 'User Data'),
      path.join(localAppData, 'Microsoft', 'Edge Beta', 'User Data'),
      path.join(localAppData, 'Chromium', 'User Data'),
      path.join(localAppData, 'BraveSoftware', 'Brave-Browser', 'User Data'),
      path.join(localAppData, 'Vivaldi', 'User Data'),
      // Defensive: legacy/wrong-layout Roaming paths still blocked if present
      path.join(appData, 'Google', 'Chrome', 'User Data'),
      path.join(appData, 'Google', 'Chrome for Testing', 'User Data'),
    ];
  }
  return [
    path.join(home, '.config', 'google-chrome'),
    path.join(home, '.config', 'google-chrome-for-testing'),
    path.join(home, '.config', 'google-chrome-beta'),
    path.join(home, '.config', 'microsoft-edge'),
    path.join(home, '.config', 'chromium'),
    path.join(home, '.config', 'BraveSoftware', 'Brave-Browser'),
    path.join(home, '.config', 'vivaldi'),
  ];
}

function systemBrowserExecutablePaths(env = process.env, home = require('os').homedir(), platform = process.platform) {
  env = env || process.env;
  home = home || require('os').homedir();
  const plat = platform || process.platform;
  if (plat === 'darwin') return [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    path.join(home, 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'),
    '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ];
  if (plat === 'win32') {
    const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const programFiles = env.PROGRAMFILES || path.join('C:', 'Program Files');
    const programFilesX86 = env['PROGRAMFILES(X86)'] || path.join('C:', 'Program Files (x86)');
    return [
      path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(local, 'Chromium', 'Application', 'chrome.exe'),
    ];
  }
  return ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
}

function isSystemBrowserExecutable(binaryPath, options = {}) {
  const raw = path.resolve(String(binaryPath || ''));
  let resolved = normalizedPath(raw);
  try { resolved = normalizedPath(fs.realpathSync.native(raw)); } catch (_) {}
  const paths = (options.executablePaths || systemBrowserExecutablePaths(options.env, options.home)).map(normalizedPath);
  return paths.some((candidate) => candidate === resolved || candidate === normalizedPath(raw));
}

function validateDataRootIsolation(dataRoot, options = {}) {
  const root = path.resolve(String(dataRoot || ''));
  if (!root || root === path.parse(root).root) return { ok: false, message: 'environment data directory is unsafe' };
  const browserRoots = options.browserRoots || systemBrowserDataRoots(options.env, options.home);
  const conflict = browserRoots.find((browserRoot) =>
    isPathInsideOrEqual(root, browserRoot) || isPathInsideOrEqual(browserRoot, root)
  );
  if (conflict) return { ok: false, message: 'environment data directory conflicts with a system browser data directory', conflict: path.resolve(conflict), root };
  return { ok: true, root };
}

function validateDataRootIsolationSecure(dataRoot, options = {}) {
  const lexical = validateDataRootIsolation(dataRoot, options);
  if (!lexical.ok) return lexical;
  if (isLinkLike(lexical.root)) return { ok: false, message: 'environment data directory must not be a symlink or junction', root: lexical.root };
  const realRoot = realPathOrResolved(lexical.root);
  const browserRoots = options.browserRoots || systemBrowserDataRoots(options.env, options.home);
  const conflict = browserRoots.find((browserRoot) => {
    const realBrowserRoot = realPathOrResolved(browserRoot);
    return isPathInsideOrEqual(realRoot, realBrowserRoot) || isPathInsideOrEqual(realBrowserRoot, realRoot);
  });
  if (conflict) return { ok: false, message: 'environment data directory resolves into a system browser data directory', conflict, root: lexical.root };
  return { ok: true, root: lexical.root, realRoot };
}

async function ensureDataRootIsolationSecure(dataRoot, options = {}) {
  await fsp.mkdir(dataRoot, { recursive: true });
  return validateDataRootIsolationSecure(dataRoot, options);
}

/**
 * Audit isolation between running profiles.
 */
function auditIsolation(runningEntries = []) {
  const roots = runningEntries.map((item) => ({
    id: item.id,
    root: item.root || item.profileDirectory,
    port: item.port,
    pid: item.pid,
  }));
  const issues = [];
  const rootSet = new Map();
  const portSet = new Map();

  for (const entry of roots) {
    if (!entry.root) {
      issues.push({ level: 'error', id: entry.id, message: 'missing user-data-dir' });
      continue;
    }
    // Case-normalized key on Windows so C:\A and c:\a are the same root
    const resolved = path.resolve(entry.root);
    const key = normalizedPath(resolved);
    if (rootSet.has(key)) {
      issues.push({
        level: 'critical',
        id: entry.id,
        message: `user-data-dir collision with ${rootSet.get(key)}`,
        root: resolved,
      });
    } else rootSet.set(key, entry.id);

    if (entry.port) {
      const portKey = Number(entry.port) || entry.port;
      if (portSet.has(portKey)) {
        issues.push({
          level: 'critical',
          id: entry.id,
          message: `CDP port collision ${entry.port} with ${portSet.get(portKey)}`,
        });
      } else portSet.set(portKey, entry.id);
    }
  }

  return {
    ok: issues.filter((i) => i.level === 'critical').length === 0,
    count: roots.length,
    distinctRoots: rootSet.size,
    distinctPorts: portSet.size,
    issues,
    profiles: roots,
  };
}

/**
 * Ensure profile roots are nested only under allowed data root (no shared Default).
 * Windows: path comparison is case-insensitive via normalizedPath.
 */
function validateProfileRoot(dataRoot, profileRoot, profileId) {
  if (!isValidProfileId(profileId)) {
    return { ok: false, message: 'invalid profile id for isolation root' };
  }
  const base = path.resolve(dataRoot);
  const root = path.resolve(profileRoot);
  const dataCheck = validateDataRootIsolation(base);
  if (!dataCheck.ok) return dataCheck;
  // Must be strictly inside dataRoot (or equal only if profileId empty — never for real envs)
  if (!isPathInsideOrEqual(root, base) || normalizedPath(root) === normalizedPath(base)) {
    return { ok: false, message: 'profile root escapes data directory' };
  }
  const expected = path.resolve(path.join(base, profileId));
  if (normalizedPath(root) !== normalizedPath(expected)) {
    return { ok: false, message: 'profile root must be {dataRoot}/{profileId}', expected, root };
  }
  return { ok: true, root: expected };
}


async function validateProfileRootSecure(dataRoot, profileRoot, profileId, options = {}) {
  const lexical = validateProfileRoot(dataRoot, profileRoot, profileId);
  if (!lexical.ok) return lexical;
  if (options.create) {
    await fsp.mkdir(dataRoot, { recursive: true });
    await fsp.mkdir(profileRoot, { recursive: true });
  }
  const dataCheck = validateDataRootIsolationSecure(dataRoot, options);
  if (!dataCheck.ok) return dataCheck;
  if (isLinkLike(profileRoot)) return { ok: false, message: 'profile root must not be a symlink or junction', root: profileRoot };
  const realRoot = await fsp.realpath(profileRoot).catch(() => path.resolve(profileRoot));
  const realBase = await fsp.realpath(dataRoot).catch(() => path.resolve(dataRoot));
  if (!isPathInsideOrEqual(realRoot, realBase) || normalizedPath(realRoot) === normalizedPath(realBase)) {
    return { ok: false, message: 'profile root resolves outside environment data directory', root: realRoot };
  }
  return { ok: true, root: lexical.root, realRoot };
}

async function assertSafeProfileChild(profileRoot, target, options = {}) {
  const base = path.resolve(profileRoot);
  const child = path.resolve(target);
  if (!isPathInsideOrEqual(child, base) || normalizedPath(child) === normalizedPath(base)) {
    throw new Error('Isolation error: target escapes profile root');
  }
  const relative = path.relative(base, child);
  let current = base;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      const stat = await fsp.lstat(current);
      if (stat.isSymbolicLink()) throw new Error('Isolation error: symlink or junction in profile path');
    } catch (error) {
      if (error.code === 'ENOENT' && options.allowMissing !== false) break;
      throw error;
    }
  }
  return child;
}

module.exports = {
  lockPath,
  acquireProfileLock,
  releaseProfileLock,
  isPidAlive,
  isValidProfileId,
  assertProfileId,
  isPathInsideOrEqual,
  auditIsolation,
  systemBrowserDataRoots,
  systemBrowserExecutablePaths,
  isSystemBrowserExecutable,
  validateDataRootIsolation,
  validateDataRootIsolationSecure,
  ensureDataRootIsolationSecure,
  validateProfileRoot,
  validateProfileRootSecure,
  assertSafeProfileChild,
};
