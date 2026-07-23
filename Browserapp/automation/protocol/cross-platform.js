'use strict';

const path = require('path');
const { pathToFileURL } = require('url');
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

/**
 * Normalize file URL for both platforms.
 * Must percent-encode spaces / non-ASCII / #? etc. — raw `file:///C:/Users/Test User/...`
 * breaks Chromium Page.navigate and CDP on Windows (common when user profile has spaces).
 */
function toFileUrl(filePath) {
  return pathToFileURL(path.resolve(filePath)).href;
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
  const winBase = path.win32.basename(hint);
  const basenames = new Set([base, winBase].filter(Boolean));
  const compare = (value) => isWindows() ? String(value).toLowerCase() : String(value);
  const comparableCommand = compare(cmd);
  // Full absolute path (may contain spaces) appears as a substring of the command line.
  if (path.isAbsolute(hint) || path.win32.isAbsolute(hint)) {
    const resolved = path.isAbsolute(hint) ? path.resolve(hint) : path.win32.normalize(hint);
    if (comparableCommand.includes(compare(resolved)) || comparableCommand.includes(compare(hint))) return true;
  }
  // Basename as a path segment: …/OpenBrowser.bin or …\OpenBrowser
  for (const candidate of basenames) {
    if (comparableCommand.includes(`/${compare(candidate)}`) || comparableCommand.includes(`\\${compare(candidate)}`)) return true;
  }
  // Bare argv0 without directory (e.g. "node script.js", "OpenBrowser.bin --flag")
  const first = comparableCommand.split(/\s+/)[0].replace(/^['"]|['"]$/g, '');
  for (const candidate of basenames) {
    const comparableCandidate = compare(candidate);
    if (first === comparableCandidate || compare(path.basename(first)) === comparableCandidate
      || compare(path.win32.basename(first)) === comparableCandidate) return true;
  }
  // OpenBrowser Dock shell: kernel path ends with OpenBrowser, live process is OpenBrowser.bin
  if ([...basenames].some((candidate) => /^OpenBrowser(\.bin)?$/i.test(candidate))
    && /(?:^|\/|\\)OpenBrowser(?:\.bin)?(?:\s|$)/i.test(cmd)) return true;
  // env-apps Dock wrapper path is strong evidence for managed OpenBrowser shells
  if (/env-apps[/\\]/.test(cmd) && /OpenBrowser(?:\.bin)?/i.test(cmd) && /OpenBrowser/i.test(base || hint)) return true;
  return false;
}

function inspectWindowsProcess(pid) {
  const numericPid = Number(pid);
  if (!Number.isSafeInteger(numericPid) || numericPid <= 0) {
    return { ok: false, reason: 'invalid process id' };
  }
  const script = [
    `$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${numericPid}'`,
    'if ($null -eq $p) { exit 2 }',
    '[Console]::Out.Write(($p | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress))',
  ].join('; ');
  try {
    const output = execFileSync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command', script,
    ], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (!output) return { ok: false, reason: 'process is not running' };
    const record = JSON.parse(output);
    return {
      ok: true,
      pid: Number(record.ProcessId),
      executablePath: String(record.ExecutablePath || ''),
      commandLine: String(record.CommandLine || ''),
    };
  } catch (_) {
    return { ok: false, reason: 'unable to inspect process identity' };
  }
}

function extractUserDataDir(command) {
  const match = String(command || '').match(
    /(?:^|\s)(?:"--user-data-dir=([^"]*)"|'--user-data-dir=([^']*)'|--user-data-dir="([^"]*)"|--user-data-dir='([^']*)'|--user-data-dir=([^\s]+))/i
  );
  if (!match) return '';
  return String(match.slice(1).find((value) => value !== undefined) || '').trim();
}

function windowsExecutableMatches(actualExecutable, expectedExecutable) {
  const actual = path.win32.normalize(String(actualExecutable || '')).toLowerCase();
  const expected = String(expectedExecutable || '').trim();
  if (!actual || !expected) return false;
  if (path.win32.isAbsolute(expected)) {
    return actual === path.win32.normalize(expected).toLowerCase();
  }
  return path.win32.basename(actual) === path.win32.basename(expected).toLowerCase();
}

/**
 * Inspect a managed browser pid on every platform before allowing termination.
 * options.expectedExecutable(s): path(s) or basenames that may appear in the command line
 * options.expectedUserDataDir: required --user-data-dir match when set
 */
function processIdentity(pid, options = {}) {
  if (isWindows()) {
    const inspected = inspectWindowsProcess(pid);
    if (!inspected.ok) return inspected;
    const command = [inspected.executablePath, inspected.commandLine].filter(Boolean).join(' ');
    const executables = normalizeExpectedExecutables(options);
    if (executables.length && !executables.some((exe) => windowsExecutableMatches(inspected.executablePath, exe))) {
      return { ok: false, reason: 'managed executable does not match', command, executables };
    }
    if (options.expectedUserDataDir) {
      const expectedRoot = path.win32.normalize(String(options.expectedUserDataDir)).toLowerCase();
      const userDataArg = extractUserDataDir(inspected.commandLine);
      const actualRoot = path.win32.normalize(String(userDataArg || '')).toLowerCase();
      if (!userDataArg || actualRoot !== expectedRoot) {
        return { ok: false, reason: 'managed user-data-dir does not match', command };
      }
    }
    return { ok: true, command, executablePath: inspected.executablePath };
  }
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
      child.once('exit', (code) => resolve(code === 0));
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
  extractUserDataDir,
  windowsExecutableMatches,
  LOCAL_API_PORTS,
  defaultApiPort,
  defaultStageRoots,
};
