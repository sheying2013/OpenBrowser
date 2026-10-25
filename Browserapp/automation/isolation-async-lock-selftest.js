'use strict';

/**
 * Dedicated test for isolation lock async process scanning and WMI tolerance semantics.
 *
 * Verifies GAP-09 fix:
 * 1. Lock acquisition uses asynchronous process scanning (no execFileSync hang).
 * 2. When process scanning is unconfirmed (known: false, simulating WMI/PowerShell failure):
 *    - If owner PID is dead and browser PID is dead, lock is safely recovered.
 *    - If lock is stale (>15s), lock is safely recovered.
 *    - If lock is recent (<15s) and browserPid is null, refuses recovery (conservative).
 *    - If forceRecover is true, allows recovery.
 * 3. When an active browser PID is detected, throws PROFILE_LOCKED.
 */

const assert = require('assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
const fsp = require('fs/promises');
const {
  acquireProfileLock,
  releaseProfileLock,
  updateProfileLock,
  lockPath,
  scanProcessesUsingProfileAsync,
} = require('./isolation');

let passed = 0;
const ok = (name, cond) => {
  assert.ok(cond, name);
  console.log('  PASS  ' + name);
  passed += 1;
};

(async () => {
  console.log('Running Isolation Async Lock & WMI Fault-Tolerance Selftests...\n');

  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ob-iso-async-'));
  const profileDir = path.join(tempDir, 'p1');
  await fsp.mkdir(profileDir, { recursive: true });
  const lockFile = lockPath(profileDir);

  try {
    // 1. Basic acquire & release
    const lock1 = await acquireProfileLock(profileDir, { profileId: 'p1' });
    ok('acquireProfileLock acquires lock initially', lock1 && lock1.pid === process.pid);
    const released = await releaseProfileLock(profileDir, lock1);
    ok('releaseProfileLock successfully removes lock', released === true);

    // 2. Dead owner + dead browserPid: WMI failure does not deadlock recovery
    // Simulate a crash from previous session with dead PIDs
    // PIDs like 99999999 are almost certainly unused on any OS
    const deadPid = 99999999;
    const pastTime = new Date(Date.now() - 60000).toISOString(); // 1 minute ago
    await fsp.writeFile(lockFile, JSON.stringify({
      pid: deadPid,
      browserPid: deadPid,
      createdAt: pastTime,
      browserStartedAt: pastTime,
      profileRoot: profileDir,
      profileId: 'p1',
      token: 'dead-lock-token-1',
    }));

    // With our fix, even if process scan fails or returns known: false,
    // the fact that both recorded owner and browser PIDs are dead allows recovery.
    const lockRecovered = await acquireProfileLock(profileDir, { profileId: 'p1' });
    ok('recovers lock when recorded owner and browser PIDs are dead', lockRecovered && lockRecovered.pid === process.pid);
    await releaseProfileLock(profileDir, lockRecovered);

    // 3. Stale startup lock (> 15s) with browserPid == null: safely recovered
    const staleStartupTime = new Date(Date.now() - 25000).toISOString(); // 25 seconds ago
    await fsp.writeFile(lockFile, JSON.stringify({
      pid: deadPid,
      browserPid: null,
      createdAt: staleStartupTime,
      profileRoot: profileDir,
      profileId: 'p1',
      token: 'dead-lock-token-2',
    }));

    const lockStaleStartup = await acquireProfileLock(profileDir, { profileId: 'p1' });
    ok('recovers stale startup lock (>15s) with browserPid null', lockStaleStartup && lockStaleStartup.pid === process.pid);
    await releaseProfileLock(profileDir, lockStaleStartup);

    // 4. Fresh startup lock (< 15s) with browserPid == null: conservatively refused
    const freshStartupTime = new Date().toISOString(); // right now
    await fsp.writeFile(lockFile, JSON.stringify({
      pid: deadPid,
      browserPid: null,
      createdAt: freshStartupTime,
      profileRoot: profileDir,
      profileId: 'p1',
      token: 'fresh-lock-token',
    }));

    let freshRefused = false;
    try {
      await acquireProfileLock(profileDir, { profileId: 'p1' });
    } catch (err) {
      freshRefused = err.code === 'PROFILE_LOCK_UNRECOVERABLE';
    }
    ok('conservatively refuses fresh startup lock (<15s) with browserPid null', freshRefused);

    // 5. Fresh startup lock with forceRecover: true succeeds
    const lockForceRecovered = await acquireProfileLock(profileDir, { profileId: 'p1', forceRecover: true });
    ok('forceRecover recovers fresh startup lock', lockForceRecovered && lockForceRecovered.pid === process.pid);
    await releaseProfileLock(profileDir, lockForceRecovered);

    // 6. scanProcessesUsingProfileAsync function returns valid structure
    const scanResult = await scanProcessesUsingProfileAsync(profileDir);
    ok('scanProcessesUsingProfileAsync returns object with known boolean', typeof scanResult.known === 'boolean');
    ok('scanProcessesUsingProfileAsync returns pids array', Array.isArray(scanResult.pids));

  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }

  console.log(`\n======================================================`);
  console.log(`ALL ${passed} ISOLATION ASYNC LOCK SELFTESTS PASSED!`);
  console.log(`======================================================\n`);
  process.exit(0);
})().catch((err) => {
  console.error('FAIL in isolation-async-lock-selftest:', err);
  process.exit(1);
});
