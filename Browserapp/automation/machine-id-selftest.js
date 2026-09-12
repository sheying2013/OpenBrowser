'use strict';

/**
 * Self-test for the machine identifier provider.
 * Command execution is injected, so no host UUID is read and the test is
 * deterministic on every platform.
 */

const assert = require('assert');
const {
  createMachineIdProvider,
  parsePlatformUuid,
  hashGuid,
  isMixedArchitecture,
  windowsRegPrefix,
  SUPPORTED_PLATFORMS,
} = require('./machine-id');

const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, err: e.message || String(e) }); }
}
async function checkAsync(name, fn) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, err: e.message || String(e) }); }
}

const MAC_OUTPUT = '+-o IOPlatformExpertDevice  <class IOPlatformExpertDevice>\n  | |   "IOPlatformUUID" = "A1B2C3D4-E5F6-7890-ABCD-EF1234567890"\n';
const WIN_OUTPUT = '\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n    MachineGuid    REG_SZ    aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee\r\n\r\n';
const LINUX_OUTPUT = ' 0123456789abcdef0123456789abcdef \n';

/** execSync stub that returns canned output per platform. */
function stubExecSync(map, calls = []) {
  return (command) => {
    calls.push(command);
    for (const [needle, output] of map) {
      if (String(command).includes(needle)) return output;
    }
    throw new Error(`unexpected command: ${command}`);
  };
}

(async () => {
  // ---- parsing ----

  check('parsePlatformUuid reads the macOS platform uuid', () => {
    assert.strictEqual(parsePlatformUuid('darwin', MAC_OUTPUT), 'a1b2c3d4-e5f6-7890-abcd-ef1234567890');
  });

  check('parsePlatformUuid reads the windows MachineGuid', () => {
    assert.strictEqual(parsePlatformUuid('win32', WIN_OUTPUT), 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  });

  check('parsePlatformUuid reads the linux machine id', () => {
    assert.strictEqual(parsePlatformUuid('linux', LINUX_OUTPUT), '0123456789abcdef0123456789abcdef');
  });

  check('parsePlatformUuid handles freebsd like linux', () => {
    assert.strictEqual(parsePlatformUuid('freebsd', 'FREEBSD-UUID\n'), 'freebsd-uuid');
  });

  check('parsePlatformUuid returns null when the field is missing', () => {
    assert.strictEqual(parsePlatformUuid('darwin', 'no marker here'), null);
    assert.strictEqual(parsePlatformUuid('win32', 'no marker here'), null);
  });

  check('parsePlatformUuid returns null for empty input', () => {
    assert.strictEqual(parsePlatformUuid('darwin', ''), null);
    assert.strictEqual(parsePlatformUuid('linux', ''), null);
    assert.strictEqual(parsePlatformUuid('linux', '   \n'), null);
    assert.strictEqual(parsePlatformUuid('linux', null), null);
  });

  check('parsePlatformUuid returns null for an unknown platform', () => {
    assert.strictEqual(parsePlatformUuid('plan9', 'whatever'), null);
  });

  // ---- hashing ----

  check('hashGuid is deterministic and 64 hex chars', () => {
    const a = hashGuid('abc');
    assert.strictEqual(a, hashGuid('abc'));
    assert.strictEqual(a.length, 64);
    assert.ok(/^[0-9a-f]{64}$/.test(a));
  });

  check('hashGuid differs for different input', () => {
    assert.notStrictEqual(hashGuid('abc'), hashGuid('abd'));
  });

  check('hashGuid does not reveal the input', () => {
    assert.ok(!hashGuid('secret-guid').includes('secret'));
  });

  // ---- architecture detection ----

  check('isMixedArchitecture detects 32-bit node on 64-bit windows', () => {
    assert.strictEqual(isMixedArchitecture('ia32', { PROCESSOR_ARCHITEW6432: 'AMD64' }), true);
    assert.strictEqual(isMixedArchitecture('ia32', {}), false);
    assert.strictEqual(isMixedArchitecture('x64', { PROCESSOR_ARCHITEW6432: 'AMD64' }), false);
  });

  check('windowsRegPrefix chooses sysnative for mixed mode', () => {
    assert.ok(windowsRegPrefix('ia32', { PROCESSOR_ARCHITEW6432: 'AMD64' }).includes('sysnative'));
    assert.ok(windowsRegPrefix('x64', {}).includes('System32'));
  });

  check('the supported platform list covers the major desktop targets', () => {
    for (const p of ['darwin', 'win32', 'linux', 'freebsd']) {
      assert.ok(SUPPORTED_PLATFORMS.includes(p), `missing ${p}`);
    }
  });

  // ---- provider: success paths ----

  check('provider returns a hashed id on macOS', () => {
    const calls = [];
    const provider = createMachineIdProvider({
      platform: 'darwin',
      execSync: stubExecSync([['ioreg', MAC_OUTPUT]], calls),
    });
    const id = provider.machineIdSync();
    assert.strictEqual(id, hashGuid('a1b2c3d4-e5f6-7890-abcd-ef1234567890'));
    assert.ok(calls[0].includes('ioreg'));
  });

  check('provider can return the raw uuid when asked', () => {
    const provider = createMachineIdProvider({
      platform: 'darwin',
      execSync: stubExecSync([['ioreg', MAC_OUTPUT]]),
    });
    assert.strictEqual(provider.machineIdSync({ original: true }), 'a1b2c3d4-e5f6-7890-abcd-ef1234567890');
  });

  check('provider reads the registry on windows', () => {
    const calls = [];
    const provider = createMachineIdProvider({
      platform: 'win32',
      arch: 'x64',
      env: {},
      execSync: stubExecSync([['REG.exe', WIN_OUTPUT]], calls),
    });
    const id = provider.machineIdSync({ original: true });
    assert.strictEqual(id, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    assert.ok(calls[0].includes('HKEY_LOCAL_MACHINE'));
  });

  check('provider reads the machine-id file on linux', () => {
    const calls = [];
    const provider = createMachineIdProvider({
      platform: 'linux',
      execSync: stubExecSync([['machine-id', LINUX_OUTPUT]], calls),
    });
    assert.strictEqual(provider.machineIdSync({ original: true }), '0123456789abcdef0123456789abcdef');
    assert.ok(calls[0].includes('/var/lib/dbus/machine-id'));
  });

  // ---- provider: caching ----

  check('provider caches the raw value across calls', () => {
    const calls = [];
    const provider = createMachineIdProvider({
      platform: 'linux',
      execSync: stubExecSync([['machine-id', LINUX_OUTPUT]], calls),
    });
    provider.machineIdSync();
    provider.machineIdSync();
    provider.machineIdSync({ original: true });
    assert.strictEqual(calls.length, 1, 'system command runs once');
  });

  check('clearCache forces a fresh read', () => {
    const calls = [];
    const provider = createMachineIdProvider({
      platform: 'linux',
      execSync: stubExecSync([['machine-id', LINUX_OUTPUT]], calls),
    });
    provider.machineIdSync();
    provider.clearCache();
    provider.machineIdSync();
    assert.strictEqual(calls.length, 2);
  });

  // ---- provider: fallbacks and errors ----

  check('windows retries through PowerShell when the registry read fails', () => {
    const attempts = [];
    const provider = createMachineIdProvider({
      platform: 'win32',
      arch: 'x64',
      env: {},
      execSync: (command) => {
        attempts.push(command);
        if (String(command).includes('REG.exe') && !String(command).includes('&')) {
          throw new Error('registry inaccessible');
        }
        return WIN_OUTPUT;
      },
    });
    const id = provider.machineIdSync({ original: true });
    assert.strictEqual(id, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    assert.strictEqual(attempts.length, 2, 'one direct attempt, one PowerShell retry');
  });

  check('windows does not retry PowerShell when the first read succeeds', () => {
    const attempts = [];
    const provider = createMachineIdProvider({
      platform: 'win32',
      arch: 'x64',
      env: {},
      execSync: (command) => {
        attempts.push(command);
        return WIN_OUTPUT;
      },
    });
    provider.machineIdSync();
    assert.strictEqual(attempts.length, 1);
  });

  check('provider throws for an unsupported platform', () => {
    const provider = createMachineIdProvider({ platform: 'plan9', execSync: () => '' });
    assert.throws(() => provider.machineIdSync(), /unsupported platform/);
  });

  check('provider throws when no identifier can be parsed', () => {
    const provider = createMachineIdProvider({
      platform: 'linux',
      execSync: () => '   \n',
    });
    assert.throws(() => provider.machineIdSync(), /could not read machine id/);
  });

  check('provider surfaces the underlying command error', () => {
    const provider = createMachineIdProvider({
      platform: 'linux',
      execSync: () => { throw new Error('command missing'); },
    });
    assert.throws(() => provider.machineIdSync(), /command missing/);
  });

  // ---- async variant ----

  await checkAsync('async provider resolves a hashed id', async () => {
    const provider = createMachineIdProvider({
      platform: 'linux',
      exec: (command, options, cb) => cb(null, LINUX_OUTPUT),
    });
    const id = await provider.machineId();
    assert.strictEqual(id, hashGuid('0123456789abcdef0123456789abcdef'));
  });

  await checkAsync('async provider serves the cache filled by the sync path', async () => {
    let asyncCalls = 0;
    const provider = createMachineIdProvider({
      platform: 'linux',
      execSync: stubExecSync([['machine-id', LINUX_OUTPUT]]),
      exec: (command, options, cb) => { asyncCalls += 1; cb(null, LINUX_OUTPUT); },
    });
    provider.machineIdSync();
    const id = await provider.machineId();
    assert.strictEqual(id, hashGuid('0123456789abcdef0123456789abcdef'));
    assert.strictEqual(asyncCalls, 0, 'no second system call needed');
  });

  await checkAsync('async provider rejects for an unsupported platform', async () => {
    const provider = createMachineIdProvider({ platform: 'plan9', exec: () => {} });
    await assert.rejects(() => provider.machineId(), /unsupported platform/);
  });

  await checkAsync('async provider falls back to PowerShell on windows', async () => {
    const attempts = [];
    const provider = createMachineIdProvider({
      platform: 'win32',
      arch: 'x64',
      env: {},
      exec: (command, options, cb) => {
        attempts.push(command);
        if (!String(command).includes('&')) cb(new Error('registry inaccessible'), '');
        else cb(null, WIN_OUTPUT);
      },
    });
    const id = await provider.machineId({ original: true });
    assert.strictEqual(id, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    assert.strictEqual(attempts.length, 2);
  });

  await checkAsync('async provider rejects when parsing yields nothing', async () => {
    const provider = createMachineIdProvider({
      platform: 'linux',
      exec: (command, options, cb) => cb(null, '   \n'),
    });
    await assert.rejects(() => provider.machineId(), /could not read machine id/);
  });

  // ---- report ----
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  for (const r of results) {
    console.log(`${r.ok ? 'ok  ' : 'FAIL'}  ${r.name}${r.ok ? '' : `  -> ${r.err}`}`);
  }
  console.log(`\nMACHINE_ID_SELFTEST ${failed.length ? 'FAILED' : 'OK'} ${passed}/${results.length}`);
  if (failed.length) process.exitCode = 1;
})();
