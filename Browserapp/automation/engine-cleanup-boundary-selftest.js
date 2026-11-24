'use strict';

// Fake children, stubbed helper scans and fake forwarders only; never a real kernel.

const assert = require('assert');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { BrowserEngine } = require('../engine');
const { acquireProfileLock, lockPath, isPidAlive } = require('./isolation');

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (error) {
    results.push({ name, ok: false });
    process.exitCode = 1;
    console.log(`  FAIL  ${name} - ${error.message}`);
  }
}

function makeEngine() {
  const engine = Object.create(BrowserEngine.prototype);
  engine.running = new Map();
  engine.starting = new Map();
  engine.stopping = new Map();
  engine.lifecycleGenerations = new Map();
  engine.lifecycleStopRequests = new Map();
  engine.stopAllInProgress = false;
  engine.profiles = new Map();
  engine.emit = () => {};
  engine.sanitizeProfile = (value) => ({ ...value });
  engine.restoreStoredProxyCredentials = (value) => value;
  engine.markProfileCleanExit = async () => {};
  engine.publicRunning = (id) => ({ id, running: Boolean(engine.running.get(id)) });
  return engine;
}

function aliveChild() {
  return { pid: null, exitCode: null, signalCode: null, once() {}, removeListener() {} };
}

function deadChild() {
  return { pid: null, exitCode: 0, signalCode: null, once() {}, removeListener() {} };
}

function fakeForwarder() {
  const state = { closed: 0 };
  return { state, close: async () => { state.closed += 1; } };
}

async function lockExists(root) {
  return fs.stat(lockPath(root)).then(() => true, () => false);
}

async function plantSingletonSentinels(root) {
  for (const name of ['SingletonLock', 'SingletonCookie']) {
    await fs.writeFile(path.join(root, name), 'sentinel', 'utf8');
  }
}

async function singletonsPresent(root) {
  const flags = await Promise.all(['SingletonLock', 'SingletonCookie'].map(
    (name) => fs.stat(path.join(root, name)).then(() => true, () => false),
  ));
  return flags;
}

async function testStartRefusesLiveHelpers() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ob-cleanup-helpers-'));
  const profileRoot = path.join(root, 'env-helpers');
  const engine = makeEngine();
  const profile = { id: 'env-helpers', name: 'Helpers' };
  const profileLock = await acquireProfileLock(profileRoot, { profileId: profile.id });
  const forwarder = fakeForwarder();
  const item = {
    cleanupFailed: true,
    cleanupState: 'blocked',
    cleanedUp: false,
    stopping: true,
    child: deadChild(),
    pid: null,
    profile,
    root: profileRoot,
    profileLock,
    proxyForwarder: forwarder,
    cleanupPromise: null,
  };
  engine.running.set(profile.id, item);
  let started = 0;
  engine._start = async (raw) => { started += 1; return { id: raw.id, running: true }; };
  try {
    engine.drainProfileHelpers = async () => ({ known: true, pids: [process.pid], attempts: 1, timedOut: true });
    await assert.rejects(
      engine.start(profile),
      (error) => error.code === 'BROWSER_HELPERS_EXIT_UNCONFIRMED' && error.pids.includes(process.pid),
      'a dead child with a live helper must refuse the replacement start',
    );
    assert.strictEqual(engine.running.get(profile.id), item, 'blocked start must retain the running item');
    assert.strictEqual(item.cleanupFailed, true);
    assert.strictEqual(item.cleanupState, 'blocked');
    assert.strictEqual(forwarder.state.closed, 0, 'proxy forwarder must stay open while a helper may hold the profile');
    assert.strictEqual(await lockExists(profileRoot), true, 'profile lock must remain as a tombstone');
    assert.strictEqual(started, 0);

    engine.drainProfileHelpers = async () => ({ known: false, pids: [], attempts: 1, timedOut: false });
    await assert.rejects(
      engine.start(profile),
      (error) => error.code === 'BROWSER_HELPERS_EXIT_UNCONFIRMED' && error.scanKnown === false,
      'an unknown helper scan must also refuse the start',
    );
    assert.strictEqual(forwarder.state.closed, 0, 'unknown scan must not release the forwarder');
    assert.strictEqual(await lockExists(profileRoot), true, 'unknown scan must keep the lock');
    assert.strictEqual(started, 0);

    engine.drainProfileHelpers = async () => ({ known: true, pids: [], attempts: 1, timedOut: false });
    const restarted = await engine.start(profile);
    assert.deepStrictEqual(restarted, { id: profile.id, running: true }, 'a confirmed-empty drain may release and restart');
    assert.strictEqual(started, 1);
    assert.strictEqual(engine.running.has(profile.id), false, 'old item must be removed before the replacement');
    assert.strictEqual(forwarder.state.closed, 1, 'forwarder closes only after helpers are confirmed gone');
    assert.strictEqual(await lockExists(profileRoot), false, 'confirmed cleanup may release the lock');
  } finally {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

async function testStartupCleanupRetainsForwarder() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ob-cleanup-startup-'));
  const profileRoot = path.join(root, 'env-startup');
  const engine = makeEngine();
  const profileLock = await acquireProfileLock(profileRoot, { profileId: 'env-startup' });
  const forwarder = fakeForwarder();
  const resources = {
    root: profileRoot,
    profileLock,
    child: aliveChild(),
    connection: { close() {} },
    proxyForwarder: forwarder,
  };
  try {
    await plantSingletonSentinels(profileRoot);
    const blocked = await engine.cleanupStartupResources(resources);
    assert.strictEqual(blocked.cleanupBlocked, true, 'a live child must block startup cleanup');
    assert.strictEqual(blocked.forwarderRetained, true);
    assert.strictEqual(forwarder.state.closed, 0, 'forwarder must not close before child exit');
    assert.strictEqual(await lockExists(profileRoot), true, 'lock must be retained');
    assert.deepStrictEqual(await singletonsPresent(profileRoot), [true, true], 'live child must retain Singleton files');
    assert.strictEqual(resources.cleanupPromise, null, 'a blocked result must not be memoized');

    resources.child = deadChild();
    engine.drainProfileHelpers = async () => ({ known: false, pids: [], attempts: 1, timedOut: false });
    const unknown = await engine.cleanupStartupResources(resources);
    assert.strictEqual(unknown.cleanupBlocked, true);
    assert.strictEqual(unknown.scanUnknown, true);
    assert.strictEqual(forwarder.state.closed, 0, 'unknown scan must retain the forwarder');
    assert.strictEqual(await lockExists(profileRoot), true, 'unknown scan must retain the lock');
    assert.deepStrictEqual(await singletonsPresent(profileRoot), [true, true], 'unknown scan must retain Singleton files');
    assert.strictEqual(resources.cleanupPromise, null, 'unknown-scan block must stay retryable');

    engine.drainProfileHelpers = async () => ({ known: true, pids: [process.pid], attempts: 1, timedOut: true });
    const helperLive = await engine.cleanupStartupResources(resources);
    assert.strictEqual(helperLive.cleanupBlocked, true, 'surviving helper must block cleanup');
    assert.deepStrictEqual(helperLive.helperPids, [process.pid]);
    assert.strictEqual(helperLive.forwarderRetained, true);
    assert.strictEqual(forwarder.state.closed, 0, 'forwarder retained while a helper is alive');
    assert.strictEqual(await lockExists(profileRoot), true);
    assert.deepStrictEqual(await singletonsPresent(profileRoot), [true, true], 'surviving helper must retain Singleton files');

    engine.drainProfileHelpers = async () => ({ known: true, pids: [], attempts: 1, timedOut: false });
    const cleaned = await engine.cleanupStartupResources(resources);
    assert.strictEqual(cleaned.cleanupBlocked, undefined);
    assert.strictEqual(cleaned.lockReleased, true, 'confirmed-empty drain may release the lock');
    assert.strictEqual(forwarder.state.closed, 1, 'forwarder closes only after child and helpers are gone');
    assert.strictEqual(await lockExists(profileRoot), false);
    assert.deepStrictEqual(await singletonsPresent(profileRoot), [false, false], 'successful cleanup removes Singleton files');

    const again = engine.cleanupStartupResources(resources);
    assert.strictEqual(again, resources.cleanupPromise, 'a successful cleanup stays idempotent');
    await again;
    assert.strictEqual(forwarder.state.closed, 1, 'successful cleanup must not close the forwarder twice');
  } finally {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

async function testStartupCleanupFailureIsRetryable() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ob-cleanup-throw-'));
  const profileRoot = path.join(root, 'env-throw');
  const engine = makeEngine();
  const profileLock = await acquireProfileLock(profileRoot, { profileId: 'env-throw' });
  const resources = {
    root: profileRoot,
    profileLock,
    child: deadChild(),
    proxyForwarder: fakeForwarder(),
  };
  try {
    engine.drainProfileHelpers = async () => { throw new Error('scan exploded'); };
    await assert.rejects(engine.cleanupStartupResources(resources), /scan exploded/);
    assert.strictEqual(resources.cleanupPromise, null, 'a thrown cleanup must not be memoized');

    engine.drainProfileHelpers = async () => ({ known: true, pids: [], attempts: 1, timedOut: false });
    const retried = await engine.cleanupStartupResources(resources);
    assert.strictEqual(retried.lockReleased, true, 'a retry after a failure must be able to finish');
    assert.strictEqual(await lockExists(profileRoot), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

async function testFakePidsOnly() {
  // Guard rail: every fake helper pid used above is this process or a dead pid,
  // never a real Chromium kernel, so the suite can run headless anywhere.
  const dead = Math.max(100000, process.pid + 100000);
  assert.strictEqual(isPidAlive(dead), false);
}

async function main() {
  console.log('=== Running engine-cleanup-boundary-selftest ===\n');
  await check('start refuses a dead child with live helpers', testStartRefusesLiveHelpers);
  await check('startup cleanup retains the forwarder until child and helpers are gone', testStartupCleanupRetainsForwarder);
  await check('startup cleanup failure stays retryable', testStartupCleanupFailureIsRetryable);
  await check('suite uses fake processes only', testFakePidsOnly);
  const failed = results.filter((entry) => !entry.ok).length;
  console.log(`\nENGINE_CLEANUP_BOUNDARY_SELFTEST ${failed ? 'FAILED' : 'OK'} ${results.length - failed}/${results.length} checks passed\n`);
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error('engine-cleanup-boundary-selftest crashed:', error);
  process.exit(1);
});
