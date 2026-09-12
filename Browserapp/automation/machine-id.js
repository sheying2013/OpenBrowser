'use strict';

/**
 * Stable machine identifier.
 *
 * Each supported platform exposes a UUID or GUID that survives reboots:
 *
 *   macOS   IOPlatformUUID via `ioreg`
 *   Linux   /var/lib/dbus/machine-id (falls back to /etc/machine-id, then hostname)
 *   Windows MachineGuid via the registry
 *
 * The raw value is hashed with SHA-256 before use so the identifier can be
 * stored or transmitted without carrying the underlying platform UUID.
 *
 * Platform, environment and command execution are all injectable, which makes
 * the parsing logic testable without touching the host.
 */

const { execSync: defaultExecSync, exec: defaultExec } = require('child_process');
const { createHash } = require('crypto');

const WIN32_REG_NATIVE = '%windir%\\System32';
const WIN32_REG_MIXED = '%windir%\\sysnative\\cmd.exe /c %windir%\\System32';

const REG_QUERY =
  'REG.exe QUERY HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography /v MachineGuid';

const COMMANDS = {
  darwin: 'ioreg -rd1 -c IOPlatformExpertDevice',
  linux: '( cat /var/lib/dbus/machine-id /etc/machine-id 2> /dev/null || hostname ) | head -n 1 || :',
  freebsd: 'kenv -q smbios.system.uuid || sysctl -n kern.hostuuid',
};

const POWERSHELL_COMMANDS = {
  native: `& "\${env:windir}\\System32\\REG.exe" QUERY "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid`,
  mixed: `& "\${env:windir}\\sysnative\\REG.exe" QUERY "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid`,
};

const SUPPORTED = new Set(['darwin', 'win32', 'linux', 'freebsd']);

/** Detect a 32-bit process running on 64-bit Windows. */
function isMixedArchitecture(arch, env = {}) {
  return arch === 'ia32' && Object.prototype.hasOwnProperty.call(env, 'PROCESSOR_ARCHITEW6432');
}

function windowsRegPrefix(arch, env) {
  return isMixedArchitecture(arch, env) ? WIN32_REG_MIXED : WIN32_REG_NATIVE;
}

/**
 * Turn raw command output into a normalized identifier.
 * Returns null when the expected field is absent rather than throwing.
 */
function parsePlatformUuid(platform, output) {
  const text = output === null || output === undefined ? '' : String(output);

  if (platform === 'darwin') {
    const marker = text.split('IOPlatformUUID')[1];
    if (!marker) return null;
    const value = marker.split('\n')[0].replace(/=|\s+|"/gi, '');
    return value ? value.toLowerCase() : null;
  }

  if (platform === 'win32') {
    const marker = text.split('REG_SZ')[1];
    if (!marker) return null;
    const value = marker.replace(/\r+|\n+|\s+/gi, '');
    return value ? value.toLowerCase() : null;
  }

  if (platform === 'linux' || platform === 'freebsd') {
    const value = text.replace(/\r+|\n+|\s+/gi, '');
    return value ? value.toLowerCase() : null;
  }

  return null;
}

/** SHA-256 hex digest, used to avoid storing the platform UUID directly. */
function hashGuid(guid) {
  return createHash('sha256').update(String(guid)).digest('hex');
}

function createMachineIdProvider(options = {}) {
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  const env = options.env || process.env;
  const runSync = options.execSync || defaultExecSync;
  const runAsync = options.exec || defaultExec;
  const cache = new Map();

  function buildCommand(usePowershell) {
    if (platform !== 'win32') {
      return { command: COMMANDS[platform], options: {} };
    }
    if (usePowershell) {
      const mixed = isMixedArchitecture(arch, env);
      return {
        command: mixed ? POWERSHELL_COMMANDS.mixed : POWERSHELL_COMMANDS.native,
        options: { shell: 'powershell.exe' },
      };
    }
    return {
      command: `${windowsRegPrefix(arch, env)}\\${REG_QUERY}`,
      options: {},
    };
  }

  function readRaw(usePowershell) {
    const { command, options } = buildCommand(usePowershell);
    const output = runSync(command, options);
    return parsePlatformUuid(platform, output);
  }

  /** Read the platform UUID (unhashed). */
  function rawGuid() {
    if (cache.has('raw')) return cache.get('raw');
    if (!SUPPORTED.has(platform)) {
      throw new Error(`unsupported platform: ${platform}`);
    }

    let value = null;
    let lastError = null;
    try {
      value = readRaw(false);
    } catch (err) {
      lastError = err;
    }
    // Windows: the registry read fails under a 32-bit process on 64-bit Windows,
    // so retry through PowerShell before giving up.
    if (!value && platform === 'win32') {
      try {
        value = readRaw(true);
      } catch (err) {
        lastError = lastError || err;
      }
    }
    if (!value) {
      throw lastError || new Error('could not read machine id');
    }
    cache.set('raw', value);
    return value;
  }

  /** Machine identifier, hashed unless `original` is set. */
  function machineIdSync({ original = false } = {}) {
    const raw = rawGuid();
    return original ? raw : hashGuid(raw);
  }

  /** Async variant, kept for callers that cannot block the event loop. */
  function machineId({ original = false } = {}) {
    return new Promise((resolve, reject) => {
      if (cache.has('raw')) {
        const cached = cache.get('raw');
        resolve(original ? cached : hashGuid(cached));
        return;
      }
      if (!SUPPORTED.has(platform)) {
        reject(new Error(`unsupported platform: ${platform}`));
        return;
      }

      const attempt = (usePowershell) => {
        const { command, options } = buildCommand(usePowershell);
        runAsync(command, options, (err, stdout) => {
          const parsed = err ? null : parsePlatformUuid(platform, stdout);
          if (parsed) {
            cache.set('raw', parsed);
            resolve(original ? parsed : hashGuid(parsed));
            return;
          }
          if (platform === 'win32' && !usePowershell) {
            attempt(true);
            return;
          }
          reject(err || new Error('could not read machine id'));
        });
      };

      attempt(false);
    });
  }

  /** Drop the memoised value (useful after a platform change in tests). */
  function clearCache() {
    cache.clear();
  }

  return { platform, rawGuid, machineIdSync, machineId, clearCache, buildCommand };
}

/** Provider bound to the current process. */
const provider = createMachineIdProvider();

module.exports = {
  createMachineIdProvider,
  machineId: provider.machineId,
  machineIdSync: provider.machineIdSync,
  parsePlatformUuid,
  hashGuid,
  isMixedArchitecture,
  windowsRegPrefix,
  SUPPORTED_PLATFORMS: [...SUPPORTED],
};
