'use strict';

const path = require('path');
const { spawn, execFileSync } = require('child_process');

/**
 * Cross-platform helpers for Win/macOS/Linux.
 */

function platform() {
  return process.platform; // win32 | darwin | linux
}

function isWindows() { return process.platform === 'win32'; }
function isMac() { return process.platform === 'darwin'; }
function isLinux() { return process.platform === 'linux'; }

/** Native input tool name (docs; openbrowser uses native-input-mirror on Win) */
function nativeToolName() {
  if (isWindows()) return 'native-input-mirror.exe';
  if (isMac()) return 'CDP-only page sync';
  return 'CDP-only';
}

/**
 * Window sync strategy:
 *  - Page content: both platforms use CDP (live-sync)
 *  - Chrome chrome:// UI / OS chrome:
 *      Win → native hook (native-input-mirror)
 *      Mac → primarily CDP (Page.bringToFront / setWindowBounds)
 */
function syncCapabilities() {
  return {
    platform: platform(),
    pageCdpSync: true,
    headboxPrivateCdp: false, // custom kernel CDP only
    nativeOsInputMirror: isWindows(),
    windowArrangeCdp: true,
    extensionLoadFlag: true,
    rpaPuppeteerConnect: true,
  };
}

function pathJoin(...parts) {
  return path.join(...parts);
}

/** Normalize file URL for both platforms */
function toFileUrl(filePath) {
  const normalized = path.resolve(filePath).replace(/\\/g, '/');
  if (isWindows()) {
    // file:///C:/...
    return 'file:///' + normalized;
  }
  return 'file://' + normalized;
}

/**
 * Normalize expectedExecutable / expectedExecutables into a list of path or basename hints.
 * Dock shells spawn …/环境 N.app/…/OpenBrowser.bin while kernel meta still points at …/OpenBrowser.
 */
function normalizeExpectedExecutables(options = {}) {
  const raw = options.expectedExecutables != null
    ? options.expectedExecutables
    : options.expectedExecutable;
  if (raw == null || raw === '') return [];
  return (Array.isArray(raw) ? raw : [raw])
    .map((item) => String(item || '').trim())
    .filter(Boolean);
}

/**
 * Match a live `ps` command line against one expected executable path/name.
 * Handles spaces in paths, env Dock shells (OpenBrowser.bin), and basename-only hints.
 */
function commandMatchesExecutable(command, executable) {
  const cmd = String(command || '');
  const hint = String(executable || '').trim();
  if (!cmd || !hint) return false;
  const base = path.basename(hint);
  // Full absolute path (may contain spaces) appears as a substring of the command line.
  if (path.isAbsolute(hint)) {
    const resolved = path.resolve(hint);
    if (cmd.includes(resolved) || cmd.includes(hint)) return true;
  }
  // Basename as a path segment: …/OpenBrowser.bin or …\OpenBrowser
  if (base && (cmd.includes(`/${base}`) || cmd.includes(`\\${base}`))) return true;
  // Bare argv0 without directory (e.g. "node script.js", "OpenBrowser.bin --flag")
  if (base) {
    const first = cmd.split(/\s+/)[0].replace(/^['"]|['"]$/g, '');
    if (first === base || path.basename(first) === base) return true;
  }
  // OpenBrowser Dock shell: kernel path ends with OpenBrowser, live process is OpenBrowser.bin
  if (/^OpenBrowser(\.bin)?$/i.test(base) && /(?:^|\/|\\)OpenBrowser(?:\.bin)?(?:\s|$)/i.test(cmd)) return true;
  // env-apps Dock wrapper path is strong evidence for managed OpenBrowser shells
  if (/env-apps[/\\]/.test(cmd) && /OpenBrowser(?:\.bin)?/i.test(cmd) && /OpenBrowser/i.test(base || hint)) return true;
  return false;
}

/**
 * Inspect a managed browser pid (macOS/Linux). Windows defers identity to taskkill.
 * options.expectedExecutable(s): path(s) or basenames that may appear in the command line
 * options.expectedUserDataDir: required --user-data-dir match when set
 */
function processIdentity(pid, options = {}) {
  if (isWindows()) return { ok: true, reason: 'windows identity check delegated to taskkill' };
  let command;
  try {
    command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch (_) {
    return { ok: false, reason: 'unable to inspect process identity' };
  }
  if (!command) return { ok: false, reason: 'process is not running' };
  const executables = normalizeExpectedExecutables(options);
  if (executables.length) {
    const matched = executables.some((exe) => commandMatchesExecutable(command, exe));
    if (!matched) return { ok: false, reason: 'managed executable does not match', command, executables };
  }
  if (options.expectedUserDataDir) {
    const expectedRoot = path.resolve(String(options.expectedUserDataDir));
    const userDataArg = command.match(/(?:^|\s)--user-data-dir=("[^"]*"|'[^']*'|[^\s]+)/)?.[1]?.replace(/^['"]|['"]$/g, '');
    if (path.resolve(userDataArg || '') !== expectedRoot) {
      return { ok: false, reason: 'managed user-data-dir does not match', command };
    }
  }
  return { ok: true, command };
}

function killProcessTree(pid, options = {}) {
  const force = options.force !== false;
  return new Promise((resolve) => {
    if (!pid) return resolve(false);
    const identity = processIdentity(pid, options);
    if (!identity.ok) return resolve(false);
    if (isWindows()) {
      const args = force ? ['/PID', String(pid), '/T', '/F'] : ['/PID', String(pid), '/T'];
      const child = spawn('taskkill.exe', args, { windowsHide: true, stdio: 'ignore' });
      child.once('exit', () => resolve(true));
      child.once('error', () => resolve(false));
      return;
    }
    try {
      const pgid = execFileSync('ps', ['-p', String(pid), '-o', 'pgid='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (String(Number(pgid)) === String(Number(pid))) process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM');
      else process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
      return resolve(true);
    } catch (_) {
      try {
        process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
        return resolve(true);
      } catch (__) {
        return resolve(false);
      }
    }
  });
}

/** Default Local API port stack */
const LOCAL_API_PORTS = Object.freeze([50325, 50725, 60725]);

function defaultApiPort() {
  const env = Number(process.env.OPENBROWSER_API_PORT || process.env.API_PORT || 0);
  return env > 0 ? env : LOCAL_API_PORTS[0];
}

/** User-data roots for staging extensions (cross-platform) */
function defaultStageRoots(userData) {
  const base = path.join(userData, 'app-center-stage');
  return {
    extensionCenter: path.join(base, 'extensionCenter'),
    cacheFolder: path.join(base, 'cache'),
    globalExtensionRoot: path.join(base, 'extension'),
  };
}

module.exports = {
  platform,
  isWindows,
  isMac,
  isLinux,
  nativeToolName,
  syncCapabilities,
  pathJoin,
  toFileUrl,
  killProcessTree,
  processIdentity,
  commandMatchesExecutable,
  normalizeExpectedExecutables,
  LOCAL_API_PORTS,
  defaultApiPort,
  defaultStageRoots,
};
