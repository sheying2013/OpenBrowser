'use strict';

const assert = require('assert');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { BrowserEngine } = require('./engine');
const {
  acquireProfileLock,
  updateProfileLock,
  releaseProfileLock,
  isPidAlive,
  lockPath,
} = require('./automation/isolation');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeEngine() {
  const engine = Object.create(BrowserEngine.prototype);
  engine.running = new Map();
  engine.starting = new Map();
  engine.stopping = new Map();
  engine.lifecycleGenerations = new Map();
  engine.lifecycleStopRequests = new Map();
  engine.stopAllPromise = null;
  engine.stopAllInProgress = false;
  engine.profiles = new Map();
  engine.emit = () => {};
  engine.sanitizeProfile = (value) => ({ ...value });
  engine.restoreStoredProxyCredentials = (value) => value;
  engine.publicRunning = (id) => ({
    id,
    running: Boolean(engine.running.get(id) && !engine.running.get(id).cleanedUp && !engine.running.get(id).stopping),
  });
  return engine;
}

async function testStateRecovery() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'openbrowser-engine-state-'));
  const app = { getPath: (name) => (name === 'userData' ? root : '') };
  const stateFile = path.join(root, 'openbrowser-engine.json');
  const profile = {
    id: 'recovered-env', name: 'Recovered environment', browser: 'Google Chrome',
    networkMode: 'proxy', proxy: 'socks5://recover-user:recover-pass@proxy.test:1080',
    platform: { type: 'other', startUrl: 'https://example.com/' },
  };
  try {
    await fs.writeFile(stateFile, '{broken json', 'utf8');
    await fs.writeFile(stateFile + '.bak', JSON.stringify({ version: 1, profiles: [profile] }), 'utf8');
    const engine = new BrowserEngine(app);
    await engine.init(null);
    assert.strictEqual(engine.profiles.get(profile.id).proxy, profile.proxy, 'valid .bak must recover proxy credentials');
    await engine.flushPersistence();
    const persisted = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    assert.strictEqual(persisted.profiles[0].proxy, profile.proxy, 'recovered state must be rewritten durably');
  } finally {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

function deadPid() {
  let candidate = Math.max(100000, process.pid + 100000);
  while (isPidAlive(candidate)) candidate += 1;
  return candidate;
}

async function testProfileLockRecovery() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'openbrowser-profile-lock-'));
  const profileRoot = path.join(root, 'env-a');
  const otherRoot = path.join(root, 'env-other');
  const file = lockPath(profileRoot);
  const stale = {
    profileId: 'env-a',
    profileRoot: path.resolve(profileRoot),
    pid: deadPid(),
    token: 'stale-token',
    createdAt: new Date(0).toISOString(),
  };
  try {
    await fs.mkdir(profileRoot, { recursive: true });
    await fs.writeFile(file, JSON.stringify(stale), 'utf8');
    const recovered = await acquireProfileLock(profileRoot, { profileId: 'env-a' });
    assert.strictEqual(recovered.profileId, 'env-a');
    assert.strictEqual(path.resolve(recovered.profileRoot), path.resolve(profileRoot));
    assert.strictEqual(await releaseProfileLock(profileRoot, recovered), true);
    assert.strictEqual(await fs.stat(file).then(() => true, () => false), false, 'recovered lock must be released');

    await fs.writeFile(file, JSON.stringify({ ...stale, profileRoot: path.resolve(otherRoot) }), 'utf8');
    await assert.rejects(
      acquireProfileLock(profileRoot, { profileId: 'env-a' }),
      (error) => error.code === 'PROFILE_LOCK_UNRECOVERABLE',
    );
    assert.strictEqual(await fs.readFile(file, 'utf8'), JSON.stringify({ ...stale, profileRoot: path.resolve(otherRoot) }), 'foreign lock must be retained');

    await fs.writeFile(file, '{broken lock', 'utf8');
    await assert.rejects(
      acquireProfileLock(profileRoot, { profileId: 'env-a' }),
      (error) => error.code === 'PROFILE_LOCK_UNRECOVERABLE',
    );
    assert.strictEqual(await fs.readFile(file, 'utf8'), '{broken lock', 'corrupt lock must be retained');
    await fs.rm(file, { force: true });

    const guard = `${file}.guard`;
    await fs.mkdir(guard, { recursive: true });
    await fs.writeFile(path.join(guard, 'owner.json'), JSON.stringify({
      profileId: 'env-a',
      profileRoot: path.resolve(profileRoot),
      pid: deadPid(),
    }), 'utf8');
    const recoveredAfterGuard = await acquireProfileLock(profileRoot, { profileId: 'env-a' });
    assert.ok(recoveredAfterGuard.token);
    assert.strictEqual(await releaseProfileLock(profileRoot, recoveredAfterGuard), true);

    // A crash between legacy guard mkdir() and owner.json write must no longer
    // deadlock the profile. The unknown guard is retained because no PID can be
    // safely verified, while the new atomic lock remains usable.
    await fs.mkdir(guard, { recursive: true });
    const recoveredAfterEmptyGuard = await acquireProfileLock(profileRoot, { profileId: 'env-a' });
    assert.ok(recoveredAfterEmptyGuard.token);
    assert.strictEqual(await releaseProfileLock(profileRoot, recoveredAfterEmptyGuard), true);
    assert.strictEqual(await fs.stat(guard).then(() => true, () => false), true, 'unknown legacy guard must not be deleted');
    await fs.rm(guard, { recursive: true, force: true });

    const live = await acquireProfileLock(profileRoot, { profileId: 'env-a' });
    await assert.rejects(
      acquireProfileLock(profileRoot, { profileId: 'env-a' }),
      (error) => error.code === 'PROFILE_LOCKED' && error.lock?.pid === process.pid,
    );
    assert.strictEqual(await releaseProfileLock(profileRoot, live), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

async function testBrowserPidPreventsRecovery() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'openbrowser-browser-lock-'));
  const profileRoot = path.join(root, 'env-browser-live');
  const file = lockPath(profileRoot);
  const electronDeadPid = deadPid();
  const browserDeadPid = deadPid();
  try {
    const owner = await acquireProfileLock(profileRoot, { profileId: 'env-browser-live' });
    assert.strictEqual(owner.browserPid, null, 'new locks must be fail-closed before browser pid binding');
    const bound = await updateProfileLock(profileRoot, owner, {
      browserPid: process.pid,
      browserProfileRoot: path.resolve(profileRoot),
      browserExecutable: process.execPath,
    });
    assert.strictEqual(bound.browserPid, process.pid, 'lock must record the Chromium child pid');
    assert.strictEqual(bound.pid, process.pid, 'top-level pid must remain the Electron owner pid');
    assert.strictEqual(await updateProfileLock(profileRoot, { ...bound, token: 'wrong-token' }, { browserPid: browserDeadPid }), false);
    assert.strictEqual(JSON.parse(await fs.readFile(file, 'utf8')).browserPid, process.pid, 'foreign update must not overwrite lock');
    assert.strictEqual(await releaseProfileLock(profileRoot, bound), true);

    // Simulate a crash after lock creation but before spawn() returned a child
    // pid. Process-list inspection proves no browser owns this profile, so the
    // pending lock is recoverable instead of becoming a permanent tombstone.
    const pending = {
      profileId: 'env-browser-live',
      profileRoot: path.resolve(profileRoot),
      pid: electronDeadPid,
      browserPid: null,
      token: 'pending-owner',
      createdAt: new Date(0).toISOString(),
    };
    await fs.writeFile(file, JSON.stringify(pending), 'utf8');
    const recoveredPending = await acquireProfileLock(profileRoot, { profileId: 'env-browser-live' });
    assert.ok(recoveredPending.token, 'pending lock with no live browser must be recoverable');
    assert.strictEqual(await releaseProfileLock(profileRoot, recoveredPending), true);

    // Simulate an app restart: the old Electron pid is gone, but its Chromium
    // child is still alive. Recovery must retain the lock and refuse the opener.
    const childStillLive = {
      profileId: 'env-browser-live',
      profileRoot: path.resolve(profileRoot),
      pid: electronDeadPid,
      browserPid: process.pid,
      token: 'old-owner',
      createdAt: new Date(0).toISOString(),
    };
    await fs.writeFile(file, JSON.stringify(childStillLive), 'utf8');
    await assert.rejects(
      acquireProfileLock(profileRoot, { profileId: 'env-browser-live' }),
      (error) => error.code === 'PROFILE_LOCKED' && error.lock?.browserPid === process.pid,
    );
    assert.deepStrictEqual(JSON.parse(await fs.readFile(file, 'utf8')), childStillLive, 'live browser lock must be retained byte-for-byte semantically');

    // Once both recorded owners are definitely gone, the lock remains
    // recoverable for compatibility with normal crash recovery.
    const staleChild = { ...childStillLive, browserPid: browserDeadPid };
    await fs.writeFile(file, JSON.stringify(staleChild), 'utf8');
    const recovered = await acquireProfileLock(profileRoot, { profileId: 'env-browser-live' });
    assert.strictEqual(await releaseProfileLock(profileRoot, recovered), true);

    // A present but malformed browserPid is not safe to recover.
    await fs.writeFile(file, JSON.stringify({ ...staleChild, browserPid: 'unknown' }), 'utf8');
    await assert.rejects(
      acquireProfileLock(profileRoot, { profileId: 'env-browser-live' }),
      (error) => error.code === 'PROFILE_LOCK_UNRECOVERABLE',
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

async function testStartupResourceCleanup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'openbrowser-startup-cleanup-'));
  const profileRoot = path.join(root, 'env-startup');
  const engine = makeEngine();
  engine.markProfileCleanExit = async () => {};
  engine.clearRunningWatch = () => {};
  let connectionClosed = 0;
  let proxyClosed = 0;
  const profileLock = await acquireProfileLock(profileRoot, { profileId: 'env-startup' });
  const resources = {
    root: profileRoot,
    profileLock,
    child: { exitCode: 0, signalCode: null },
    connection: {
      close() { connectionClosed += 1; },
    },
    proxyForwarder: {
      async close() { proxyClosed += 1; },
    },
  };
  try {
    const first = engine.cleanupStartupResources(resources);
    const second = engine.cleanupStartupResources(resources);
    assert.strictEqual(first, second, 'startup cleanup must be idempotent and share one promise');
    await first;
    assert.strictEqual(connectionClosed, 1);
    assert.strictEqual(proxyClosed, 1);
    assert.strictEqual(await fs.stat(lockPath(profileRoot)).then(() => true, () => false), false, 'startup failure must release profile lock');
  } finally {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

async function testCleanupFailsClosedWhenChildSurvives() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'openbrowser-fail-closed-'));
  const profileRoot = path.join(root, 'env-live-child');
  const engine = makeEngine();
  engine.emit = () => {};
  engine.markProfileCleanExit = async () => {};
  const profile = { id: 'env-live-child' };
  const profileLock = await acquireProfileLock(profileRoot, { profileId: profile.id });
  const child = {
    pid: null,
    exitCode: null,
    signalCode: null,
    once() {},
    removeListener() {},
  };
  const item = {
    child,
    pid: null,
    profile,
    root: profileRoot,
    profileLock,
    cleanedUp: false,
    stopping: false,
    cleanupPromise: null,
  };
  engine.running.set(profile.id, item);
  try {
    await assert.rejects(
      engine.cleanupRunningItem(profile.id, item, { waitForExit: true, exitTimeout: 10 }),
      (error) => error.code === 'BROWSER_EXIT_UNCONFIRMED',
    );
    assert.strictEqual(item.cleanupPromise, null, 'failed cleanup promise must be cleared for an explicit retry');
    assert.strictEqual(item.cleanedUp, false, 'failed cleanup must not claim the item is cleaned');
    assert.strictEqual(item.stopping, true, 'failed cleanup must remain visibly stopping');
    assert.strictEqual(await fs.stat(lockPath(profileRoot)).then(() => true, () => false), true, 'unconfirmed child must retain profile lock');
    assert.strictEqual(engine.running.get(profile.id), item, 'unconfirmed child must remain in running map');
    await assert.rejects(
      engine.start(profile),
      (error) => error.code === 'BROWSER_EXIT_UNCONFIRMED',
      'restart must remain blocked while child exit is unconfirmed',
    );

    child.exitCode = 137;
    const retried = await engine.stop(profile.id);
    assert.strictEqual(retried.running, false, 'confirmed exit must allow public stop retry');
    assert.strictEqual(await fs.stat(lockPath(profileRoot)).then(() => true, () => false), false, 'confirmed exit may release profile lock');
    assert.strictEqual(engine.running.has(profile.id), false, 'confirmed exit may remove running item');
  } finally {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

async function testStopAllDrainsLateRestart() {
  const engine = makeEngine();
  const calls = [];
  engine.running.set('first-env', { cleanedUp: false, stopping: false });
  engine._stop = async (id, item) => {
    calls.push(id);
    item.stopping = true;
    await sleep(5);
    if (engine.running.get(id) === item) engine.running.delete(id);
    item.cleanedUp = true;
    if (id === 'first-env') engine.running.set('late-restart', { cleanedUp: false, stopping: false });
    return { id, running: false, graceful: true };
  };
  await engine.stopAll();
  assert.deepStrictEqual(calls, ['first-env', 'late-restart'], 'stopAll must drain a restart queued during cleanup');
  assert.strictEqual(engine.running.size, 0);
  assert.strictEqual(engine.starting.size, 0);
  assert.strictEqual(engine.stopping.size, 0);
}

async function testStopCancelsInFlightStart() {
  const engine = makeEngine();
  const profile = { id: 'cancel-start', name: 'Cancel start' };
  let releasePrepare;
  const prepareGate = new Promise((resolve) => { releasePrepare = resolve; });
  engine._start = async (raw, generation) => {
    await prepareGate;
    engine.assertStartGenerationActive(raw.id, generation);
    engine.running.set(raw.id, {
      profile: raw,
      lifecycleGeneration: generation,
      cleanedUp: false,
      stopping: false,
    });
    return engine.publicRunning(raw.id);
  };

  const starting = engine.start(profile);
  await sleep(0);
  const stopping = engine.stop(profile.id);
  releasePrepare();
  await assert.rejects(starting, (error) => error.code === 'BROWSER_START_CANCELLED');
  const stopped = await stopping;
  assert.strictEqual(stopped.running, false, 'stop during startup must converge to stopped');
  assert.strictEqual(engine.running.size, 0);
  assert.strictEqual(engine.starting.size, 0);
  assert.strictEqual(engine.stopping.size, 0);
  assert.strictEqual(engine.lifecycleStopRequests.size, 0, 'cancel request must be cleared after stop');
}

async function testLateOldGenerationExitIsolation() {
  const engine = makeEngine();
  const oldItem = { lifecycleGeneration: 1, cleanupPromise: null };
  const newItem = { lifecycleGeneration: 2, cleanupPromise: null };
  engine.running.set('generation-env', newItem);
  const newStop = new Promise(() => {});
  newStop.lifecycleItem = newItem;
  newStop.lifecycleGeneration = 2;
  engine.stopping.set('generation-env', newStop);
  let cleanupOptions = null;
  engine.cleanupRunningItem = async (_id, item, options) => {
    assert.strictEqual(item, oldItem);
    cleanupOptions = options;
    return { id: 'generation-env', running: false };
  };

  await engine.handleBrowserGone('generation-env', oldItem, 'late-old-exit');
  assert.strictEqual(engine.running.get('generation-env'), newItem, 'old exit must not remove the new generation');
  assert.strictEqual(engine.stopping.get('generation-env'), newStop, 'old exit must not replace the new stop barrier');
  assert.strictEqual(cleanupOptions.emitStatus, false, 'old generation must not emit current status');
}

async function testLateExitWhileReplacementStarts() {
  const engine = makeEngine();
  const oldItem = { lifecycleGeneration: 1, cleanupPromise: null };
  const replacementStart = new Promise(() => {});
  replacementStart.lifecycleGeneration = 2;
  engine.lifecycleGenerations.set('replacement-env', 2);
  engine.starting.set('replacement-env', replacementStart);
  let cleanupOptions = null;
  engine.cleanupRunningItem = async (_id, item, options) => {
    assert.strictEqual(item, oldItem);
    cleanupOptions = options;
    return { id: 'replacement-env', running: false };
  };

  await engine.handleBrowserGone('replacement-env', oldItem, 'late-exit-during-restart');
  assert.strictEqual(engine.starting.get('replacement-env'), replacementStart, 'old exit must not disturb replacement start');
  assert.strictEqual(engine.stopping.has('replacement-env'), false, 'old exit must not install a stop barrier for replacement start');
  assert.strictEqual(cleanupOptions.emitStatus, false, 'old exit must stay silent while replacement starts');
}

async function testStopAllBoundsHungEnvironment() {
  const engine = makeEngine();
  engine.stopAllItemTimeoutMs = 35;
  engine.running.set('hung-env', { cleanedUp: false, stopping: false });
  engine.running.set('fast-env', { cleanedUp: false, stopping: false });
  engine._stop = async (id, item) => {
    item.stopping = true;
    if (id === 'hung-env') return new Promise(() => {});
    engine.running.delete(id);
    item.cleanedUp = true;
    return { id, running: false };
  };

  const startedAt = Date.now();
  const result = await engine.stopAll();
  assert.ok(Date.now() - startedAt < 500, 'one hung environment must not hang stopAll');
  assert.strictEqual(engine.running.has('fast-env'), false, 'healthy environments must still stop');
  assert.strictEqual(engine.running.has('hung-env'), true, 'timed-out environment remains visible for diagnostics');
  assert.ok(result.remaining.includes('hung-env'));
  assert.ok(result.errors.some((message) => message.includes('Timed out stopping browser environment hung-env')));
}

async function testAppQuitCleanupContract() {
  const source = await fs.readFile(path.join(__dirname, 'main.js'), 'utf8');
  assert.ok(source.includes('async function stopAllForQuit()'), 'application quit must use a dedicated browser drain');
  assert.ok(source.includes('for (let attempt = 0; attempt < 2 && remaining.length; attempt += 1)'), 'quit must retry explicit remaining environments');
  assert.ok(source.includes('if (stopResult.remaining.length) return;'), 'quit backup must not read browser data while processes remain');
  assert.ok(source.includes("app.on('window-all-closed'"), 'closing the final control window must enter application shutdown');
  assert.ok(!source.includes("if (process.platform !== 'darwin' && !quitting) app.quit();"), 'macOS final-window close must not bypass browser cleanup');
  assert.ok(source.includes('liveSync?.stop?.()'), 'quit must invalidate live-sync work before stopping environments');
}

async function main() {
  await testStateRecovery();
  await testProfileLockRecovery();
  await testBrowserPidPreventsRecovery();
  await testStartupResourceCleanup();
  await testCleanupFailsClosedWhenChildSurvives();
  await testStopAllDrainsLateRestart();
  await testStopCancelsInFlightStart();
  await testLateOldGenerationExitIsolation();
  await testLateExitWhileReplacementStarts();
  await testStopAllBoundsHungEnvironment();
  await testAppQuitCleanupContract();
  await testLockReleaseFailureRetainsRunningItem();
  await testStartupResourceCleanupUnknownScan();
  const profile = { id: 'lifecycle-env', name: 'Lifecycle environment' };
  const engine = makeEngine();
  let startCount = 0;
  let stopCount = 0;
  let failNextStart = false;

  engine._start = async (raw) => {
    startCount += 1;
    await sleep(20);
    if (failNextStart) {
      failNextStart = false;
      throw new Error('synthetic startup failure');
    }
    engine.running.set(raw.id, { cleanedUp: false, stopping: false });
    return engine.publicRunning(raw.id);
  };
  const starts = await Promise.all(Array.from({ length: 20 }, () => engine.start(profile)));
  assert.strictEqual(startCount, 1, 'concurrent starts must share one promise');
  assert.ok(starts.every((value) => value.running === true), 'all start callers receive a running result');

  engine._stop = async (id, item) => {
    stopCount += 1;
    item.stopping = true;
    await sleep(30);
    if (engine.running.get(id) === item) engine.running.delete(id);
    item.cleanedUp = true;
    return { id, running: false, graceful: true };
  };
  const stopPromise = engine.stop(profile.id);
  await sleep(5);
  const startAfterStop = engine.start(profile);
  const [stopped, restarted] = await Promise.all([stopPromise, startAfterStop]);
  assert.strictEqual(stopCount, 1, 'one stop must execute one cleanup task');
  assert.strictEqual(startCount, 2, 'restart must happen after the previous stop completes');
  assert.strictEqual(stopped.running, false);
  assert.strictEqual(restarted.running, true);

  const stopResults = await Promise.all([engine.stop(profile.id), engine.stop(profile.id)]);
  assert.strictEqual(stopCount, 2, 'concurrent stops must share one promise');
  assert.ok(stopResults.every((value) => value.running === false));
  assert.strictEqual(engine.running.size, 0);

  // Exercise repeated close/reopen cycles and prove one failed start does not
  // poison the next attempt or leave a lifecycle barrier behind.
  for (let cycle = 1; cycle <= 5; cycle += 1) {
    const started = await engine.start(profile);
    assert.strictEqual(started.running, true, `cycle ${cycle} must start`);
    const stoppedCycle = await engine.stop(profile.id);
    assert.strictEqual(stoppedCycle.running, false, `cycle ${cycle} must stop`);
    assert.strictEqual(engine.running.size, 0, `cycle ${cycle} must clear running map`);
    assert.strictEqual(engine.starting.size, 0, `cycle ${cycle} must clear starting map`);
    assert.strictEqual(engine.stopping.size, 0, `cycle ${cycle} must clear stopping map`);
  }

  failNextStart = true;
  await assert.rejects(engine.start(profile), /synthetic startup failure/);
  assert.strictEqual(engine.running.size, 0, 'failed start must not publish a running item');
  assert.strictEqual(engine.starting.size, 0, 'failed start must clear starting map');
  assert.strictEqual(engine.stopping.size, 0, 'failed start must not leave stopping map');
  const startedAfterFailure = await engine.start(profile);
  assert.strictEqual(startedAfterFailure.running, true, 'start after failure must recover');
  await engine.stop(profile.id);
  assert.strictEqual(engine.running.size, 0);
  assert.strictEqual(engine.starting.size, 0);
  assert.strictEqual(engine.stopping.size, 0);

  process.stdout.write(`LIFECYCLE_SELFTEST_OK concurrent_start=1 start_waits_stop=1 concurrent_stop=1 restart_cycles=5 failed_start_recovery=1 starts=${startCount} stops=${stopCount}\n`);
}

main().catch((error) => {
  process.stderr.write((error && error.stack) || String(error));
  process.exitCode = 1;
});


async function testLockReleaseFailureRetainsRunningItem() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'openbrowser-lock-fail-'));
  const profileRoot = path.join(root, 'env-lock-fail');
  const engine = makeEngine();
  engine.emit = () => {};
  engine.markProfileCleanExit = async () => {};
  const profile = { id: 'env-lock-fail' };
  const profileLock = await acquireProfileLock(profileRoot, { profileId: profile.id });
  const item = {
    child: { pid: 1234, exitCode: 0, signalCode: null, once() {}, removeListener() {} },
    pid: 1234,
    profile,
    root: profileRoot,
    profileLock: { pid: process.pid, token: 'invalid-token-to-fail-release' },
    cleanedUp: false,
    stopping: false,
    cleanupPromise: null,
  };
  engine.running.set(profile.id, item);
  try {
    await assert.rejects(
      engine.cleanupRunningItem(profile.id, item, { expected: true }),
      (error) => error.code === 'PROFILE_LOCK_RELEASE_FAILED',
    );
    assert.strictEqual(engine.running.get(profile.id), item, 'failed lock release must retain running item in memory');
  } finally {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

async function testStartupResourceCleanupUnknownScan() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'openbrowser-startup-scan-'));
  const profileRoot = path.join(root, 'env-startup-scan');
  const engine = makeEngine();
  const profileLock = await acquireProfileLock(profileRoot, { profileId: 'env-startup-scan' });
  const resources = {
    root: profileRoot,
    profileLock,
    child: { exitCode: 0, signalCode: null },
  };
  const originalDrain = engine.drainProfileHelpers;
  engine.drainProfileHelpers = async () => ({ known: false, pids: [], attempts: 1, timedOut: false });
  try {
    const res = await engine.cleanupStartupResources(resources);
    assert.strictEqual(res.lockReleased, false, 'unknown scan must keep lock');
    assert.strictEqual(res.cleanupBlocked, true, 'unknown scan must block cleanup');
    assert.strictEqual(await fs.stat(lockPath(profileRoot)).then(() => true, () => false), true, 'lock file must be retained');
  } finally {
    engine.drainProfileHelpers = originalDrain;
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}
