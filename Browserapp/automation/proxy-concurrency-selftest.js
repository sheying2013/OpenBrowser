'use strict';

/**
 * Per-proxy window cap and usage accounting (issue #25).
 *
 * "Why did the first ten windows work and the next one not?" is usually the upstream SOCKS5
 * endpoint hitting its concurrent-tunnel allowance. The proxy library therefore has to answer two
 * questions before that happens: which windows are on this proxy right now, and how many are
 * allowed. Both read the same association (profile.proxyId, or the raw endpoint for a manually
 * pasted proxy), so the badge in the table and the rule that blocks a start can never disagree.
 */

const assert = require('assert');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const {
  ProxyStore,
  summarizeProxyUsage,
  canAssignProxy,
  assertProxyAssignmentAvailable,
  profileMatchesProxy,
} = require('./proxy-store');
const { BrowserEngine } = require('../engine');

const results = [];
function record(name, error) {
  results.push({ name, ok: !error });
  if (error) {
    console.log(`  FAIL  ${name} - ${error.message}`);
    process.exitCode = 1;
  } else {
    console.log(`  PASS  ${name}`);
  }
}
function check(name, fn) {
  try { fn(); record(name, null); } catch (error) { record(name, error); }
}
async function asyncCheck(name, fn) {
  try { await fn(); record(name, null); } catch (error) { record(name, error); }
}

/** A BrowserEngine-shaped object: real prototype methods, stubbed collaborators. */
function makeEngine(proxyStore) {
  const engine = Object.create(BrowserEngine.prototype);
  engine.profiles = new Map();
  engine.running = new Map();
  engine.networkInfo = new Map();
  engine.starting = new Map();
  engine.stopping = new Map();
  engine.proxyStore = proxyStore;
  engine.emit = () => {};
  return engine;
}

function proxyProfile(id, { proxyId, raw, name } = {}) {
  return {
    id,
    name: name || id,
    networkMode: 'proxy',
    proxyId: proxyId || null,
    proxy: raw || '',
    proxyMeta: proxyId ? { proxyId } : {},
  };
}

function runningItem(profile) {
  return { profile, cleanedUp: false, stopping: false };
}

async function main() {
  console.log('=== Running proxy-concurrency-selftest ===\n');

  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ob-proxy-concurrency-'));
  const storeFile = path.join(dir, 'proxy-library.json');
  const store = new ProxyStore(storeFile);

  const shared = await store.create({ name: '共享节点', protocol: 'socks5', host: '10.0.0.1', port: 1080, raw: 'socks5://10.0.0.1:1080', maxConcurrency: 2 });
  const free = await store.create({ name: '不限并发', protocol: 'socks5', host: '10.0.0.2', port: 1080, raw: 'socks5://10.0.0.2:1080' });
  const manualRaw = 'socks5://10.0.0.3:1080';
  const manual = await store.create({ name: '手工粘贴', protocol: 'socks5', host: '10.0.0.3', port: 1080, raw: manualRaw, maxConcurrency: 1 });

  // --- data layer ---
  check('a new proxy defaults to no cap (0)', () => {
    assert.strictEqual(free.maxConcurrency, 0);
  });

  await asyncCheck('an explicit cap is stored and survives an unrelated update', async () => {
    const updated = await store.update(shared.id, { name: '共享节点（改名）' });
    assert.strictEqual(updated.maxConcurrency, 2, 'cap must survive a rename');
    assert.strictEqual(updated.name, '共享节点（改名）');
  });

  await asyncCheck('clearing the cap stores 0, and out-of-range input is clamped', async () => {
    const cleared = await store.update(manual.id, { maxConcurrency: 0 });
    assert.strictEqual(cleared.maxConcurrency, 0);
    const restored = await store.update(manual.id, { maxConcurrency: 1 });
    assert.strictEqual(restored.maxConcurrency, 1);
    const negative = await store.create({ name: 'neg', protocol: 'socks5', host: '10.0.0.9', port: 1, raw: 'socks5://10.0.0.9:1', maxConcurrency: -3 });
    assert.strictEqual(negative.maxConcurrency, 0, 'a negative cap means "no cap", never a zero-window deadlock');
    const huge = await store.create({ name: 'huge', protocol: 'socks5', host: '10.0.0.8', port: 1, raw: 'socks5://10.0.0.8:1', maxConcurrency: 99999 });
    assert.strictEqual(huge.maxConcurrency, 1000);
    const alias = await store.create({ name: 'alias', protocol: 'socks5', host: '10.0.0.7', port: 1, raw: 'socks5://10.0.0.7:1', max_concurrency: '4' });
    assert.strictEqual(alias.maxConcurrency, 4, 'snake_case alias must be accepted');
  });

  await asyncCheck('a library file written before the field existed still loads', async () => {
    const legacyFile = path.join(dir, 'legacy.json');
    await fsp.writeFile(legacyFile, JSON.stringify({ version: 2, items: [{ id: 'legacy', name: 'L', protocol: 'socks5', host: '9.9.9.9', port: 1080, raw: 'socks5://9.9.9.9:1080' }] }));
    const legacy = new ProxyStore(legacyFile);
    await legacy.load();
    assert.strictEqual(legacy.get('legacy').maxConcurrency, 0);
  });

  // --- usage accounting ---
  const engine = makeEngine(store);
  engine.running.set('p1', runningItem(proxyProfile('p1', { proxyId: shared.id, raw: shared.raw })));
  engine.running.set('p2', runningItem(proxyProfile('p2', { proxyId: free.id, raw: free.raw })));

  check('usage counts the windows bound to a library record', () => {
    const usage = engine.proxyConcurrencyUsage(proxyProfile('p3', { proxyId: shared.id, raw: shared.raw }));
    assert.strictEqual(usage.limit, 2);
    assert.strictEqual(usage.running.length, 1);
    assert.strictEqual(usage.running[0].id, 'p1');
  });

  check('usage counts a manual paste that matches the stored endpoint', () => {
    engine.running.set('p4', runningItem(proxyProfile('p4', { raw: manualRaw })));
    const usage = engine.proxyConcurrencyUsage(proxyProfile('p5', { proxyId: manual.id, raw: manualRaw }));
    assert.strictEqual(usage.running.length, 1);
    assert.strictEqual(usage.running[0].id, 'p4');
  });

  check('a stopping window does not hold a slot', () => {
    engine.running.get('p1').stopping = true;
    const usage = engine.proxyConcurrencyUsage(proxyProfile('p3', { proxyId: shared.id, raw: shared.raw }));
    assert.strictEqual(usage.running.length, 0);
    engine.running.get('p1').stopping = false;
  });

  check('an in-flight start holds a slot before the child process exists', () => {
    // Batch-starting N environments bound to one capped proxy: none of the siblings is in
    // `this.running` yet, so a check that only counted running windows would observe the proxy as
    // unused for every one of them and let the whole batch through.
    engine.profiles.set('p10', proxyProfile('p10', { proxyId: shared.id, raw: shared.raw }));
    engine.starting.set('p10', Promise.resolve());
    const usage = engine.proxyConcurrencyUsage(proxyProfile('p3', { proxyId: shared.id, raw: shared.raw }));
    assert.ok(usage.running.some((entry) => entry.id === 'p10'), 'an in-flight start must be counted');
    let error = null;
    try {
      engine.assertProxyConcurrencyAvailable(proxyProfile('p11', { proxyId: shared.id, raw: shared.raw }));
    } catch (err) { error = err; }
    assert.ok(error && error.code === 'ERR_PROXY_MAX_CONCURRENCY', 'a concurrent batch must not slip past the cap');
    engine.starting.delete('p10');
    engine.profiles.delete('p10');
  });

  check('the starting profile is never counted against itself', () => {
    engine.profiles.set('p12', proxyProfile('p12', { proxyId: shared.id, raw: shared.raw }));
    engine.starting.set('p12', Promise.resolve());
    const usage = engine.proxyConcurrencyUsage(proxyProfile('p12', { proxyId: shared.id, raw: shared.raw }));
    assert.strictEqual(usage.running.filter((entry) => entry.id === 'p12').length, 0, 'the caller is excluded');
    engine.starting.delete('p12');
    engine.profiles.delete('p12');
  });

  // --- enforcement ---
  check('a start under the cap is allowed', () => {
    engine.assertProxyConcurrencyAvailable(proxyProfile('p3', { proxyId: shared.id, raw: shared.raw }));
  });

  check('a start at the cap is blocked with a typed, actionable error', () => {
    engine.running.set('p6', runningItem(proxyProfile('p6', { proxyId: shared.id, raw: shared.raw })));
    let error = null;
    try {
      engine.assertProxyConcurrencyAvailable(proxyProfile('p7', { proxyId: shared.id, raw: shared.raw }));
    } catch (err) { error = err; }
    assert.ok(error, 'must throw once the cap is reached');
    assert.strictEqual(error.code, 'ERR_PROXY_MAX_CONCURRENCY');
    assert.ok(error.message.includes('2/2'), `message must show the usage: ${error.message}`);
    assert.ok(error.message.includes('p1') || error.message.includes('p6'), `message must name an occupying window: ${error.message}`);
    engine.running.delete('p6');
  });

  check('an uncapped proxy never blocks, however many windows are running', () => {
    for (let i = 0; i < 6; i += 1) {
      engine.running.set(`many-${i}`, runningItem(proxyProfile(`many-${i}`, { proxyId: free.id, raw: free.raw })));
    }
    engine.assertProxyConcurrencyAvailable(proxyProfile('p8', { proxyId: free.id, raw: free.raw }));
  });

  check('an unlinked profile is never counted against an unrelated proxy', () => {
    engine.assertProxyConcurrencyAvailable(proxyProfile('p9', { raw: 'socks5://10.9.9.9:1080' }));
  });

  check('the launch path enforces the cap before any resource is created', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'engine.js'), 'utf8');
    const resolved = source.indexOf('let profile = this.resolveStoredProxyProfile(this.sanitizeProfile(raw));');
    const guarded = source.indexOf('this.assertProxyConcurrencyAvailable(profile);');
    const lock = source.indexOf('await acquireProfileLock(');
    assert.ok(resolved > 0, 'the profile must be resolved in _start');
    assert.ok(guarded > 0, 'assertProxyConcurrencyAvailable(profile) must run inside _start');
    assert.ok(guarded > resolved, 'the cap must be checked after the stored proxy is resolved');
    assert.ok(lock < 0 || guarded < lock, 'the cap must be checked before the profile lock is taken');
    return 'cap is asserted before the lock, data directory and proxy bridge';
  });

  // --- profile assignment accounting & capacity enforcement (Issue #25) ---
  const idleProxy = await store.create({ name: '空闲代理', protocol: 'socks5', host: '10.0.0.5', port: 1080, raw: 'socks5://10.0.0.5:1080', maxConcurrency: 3 });
  const cappedProxy = await store.create({ name: '并发上限2', protocol: 'socks5', host: '10.0.0.6', port: 1080, raw: 'socks5://10.0.0.6:1080', maxConcurrency: 2 });
  const unlimitedProxy = await store.create({ name: '不限环境', protocol: 'socks5', host: '10.0.0.7', port: 1080, raw: 'socks5://10.0.0.7:1080', maxConcurrency: 0 });
  const legacyProxy = { id: 'legacy-node', name: '旧节点无字段', protocol: 'socks5', host: '10.0.0.8', port: 1080, raw: 'socks5://10.0.0.8:1080' };

  const testProfiles = [
    { id: 'env-1', name: '环境 Alpha', proxyId: cappedProxy.id },
    { id: 'env-2', name: '环境 Beta', proxyMeta: { proxy_id: cappedProxy.id } },
    { id: 'env-3', name: '环境 Gamma', proxy: 'socks5://10.0.0.8:1080' },
    { id: 'env-direct', name: '直连环境', networkMode: 'direct', proxyId: cappedProxy.id },
  ];

  check('summarizeProxyUsage correctly attributes bound profiles and identifies idle proxies', () => {
    const summary = summarizeProxyUsage([cappedProxy, idleProxy, unlimitedProxy, legacyProxy], testProfiles);
    assert.strictEqual(summary.length, 4);

    const cappedSum = summary.byId.get(cappedProxy.id);
    assert.strictEqual(cappedSum.count, 2);
    assert.strictEqual(cappedSum.limit, 2);
    assert.strictEqual(cappedSum.isFull, true);
    assert.strictEqual(cappedSum.isOverLimit, false);
    assert.strictEqual(cappedSum.isIdle, false);
    assert.strictEqual(cappedSum.available, 0);
    assert.deepStrictEqual(cappedSum.profiles.map((p) => p.id), ['env-1', 'env-2']);
    assert.strictEqual(cappedSum.profiles[0].name, '环境 Alpha');

    const idleSum = summary.byId.get(idleProxy.id);
    assert.strictEqual(idleSum.count, 0);
    assert.strictEqual(idleSum.limit, 3);
    assert.strictEqual(idleSum.isIdle, true);
    assert.strictEqual(idleSum.available, 3);
    assert.strictEqual(idleSum.profiles.length, 0);

    const legacySum = summary.byId.get(legacyProxy.id);
    assert.strictEqual(legacySum.count, 1);
    assert.strictEqual(legacySum.limit, 0);
    assert.strictEqual(legacySum.isOverLimit, false);
    assert.strictEqual(legacySum.available, null);

    assert.strictEqual(summary.idle.length, 2, 'idle getter filters accurately');
    assert.strictEqual(summary.inUse.length, 2, 'inUse getter filters accurately');
  });

  check('summarizeProxyUsage detects over-limit status when profiles exceed cap', () => {
    const overflowProfiles = [
      ...testProfiles,
      { id: 'env-overflow', name: '溢出环境', proxyId: cappedProxy.id },
    ];
    const summary = summarizeProxyUsage([cappedProxy], overflowProfiles);
    const item = summary[0];
    assert.strictEqual(item.count, 3);
    assert.strictEqual(item.limit, 2);
    assert.strictEqual(item.isOverLimit, true);
    assert.strictEqual(item.overLimit, true);
    assert.strictEqual(item.isFull, true);
    assert.strictEqual(summary.overLimit.length, 1);
  });

  check('summarizeProxyUsage handles missing maxConcurrency as 0 (no limit)', () => {
    const summary = summarizeProxyUsage([legacyProxy], testProfiles);
    assert.strictEqual(summary[0].limit, 0);
    assert.strictEqual(summary[0].maxConcurrency, 0);
    assert.strictEqual(summary[0].isOverLimit, false);
    assert.strictEqual(summary[0].isFull, false);
  });

  check('store.summarizeUsage prototype method works with active store data', () => {
    const storeSummary = store.summarizeUsage(testProfiles);
    assert.ok(Array.isArray(storeSummary));
    assert.ok(storeSummary.byId instanceof Map);
  });

  check('canAssignProxy allows assignment when proxy is uncapped (0) or legacy', () => {
    const checkUnlimited = canAssignProxy(unlimitedProxy, testProfiles, 'new-env');
    assert.strictEqual(checkUnlimited.ok, true);
    assert.strictEqual(checkUnlimited.reason, null);

    const checkLegacy = canAssignProxy(legacyProxy, testProfiles, 'new-env');
    assert.strictEqual(checkLegacy.ok, true);
    assert.strictEqual(checkLegacy.reason, null);
  });

  check('canAssignProxy allows assignment when below cap', () => {
    const checkIdle = canAssignProxy(idleProxy, testProfiles, 'new-env');
    assert.strictEqual(checkIdle.ok, true);
    assert.strictEqual(checkIdle.count, 0);
    assert.strictEqual(checkIdle.limit, 3);
  });

  check('canAssignProxy rejects new profile assignment when cap is reached', () => {
    const checkCapped = canAssignProxy(cappedProxy, testProfiles, 'new-env');
    assert.strictEqual(checkCapped.ok, false);
    assert.strictEqual(checkCapped.code, 'ERR_PROXY_MAX_CONCURRENCY');
    assert.strictEqual(checkCapped.count, 2);
    assert.strictEqual(checkCapped.limit, 2);
    assert.ok(checkCapped.reason.includes('并发上限2'), 'reason must contain proxy name');
    assert.ok(checkCapped.reason.includes('2/2'), 'reason must contain count/limit');
    assert.ok(checkCapped.reason.includes('环境 Alpha') || checkCapped.reason.includes('环境 Beta'), 'reason must name occupying profiles');
  });

  check('assertProxyAssignmentAvailable throws actionable error with details when capped', () => {
    let thrown = null;
    try {
      assertProxyAssignmentAvailable(cappedProxy, testProfiles, 'new-env');
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown, 'must throw when capped');
    assert.strictEqual(thrown.code, 'ERR_PROXY_MAX_CONCURRENCY');
    assert.strictEqual(thrown.limit, 2);
    assert.strictEqual(thrown.count, 2);
    assert.ok(thrown.message.includes('已达并发上限（2/2）'));
  });

  check('saving an existing profile assigned to a capped proxy does not block itself', () => {
    // env-1 already holds a slot on cappedProxy. Saving env-1 should not be rejected
    const updateResult = canAssignProxy(cappedProxy, testProfiles, 'env-1');
    assert.strictEqual(updateResult.ok, true, 'updating own profile must be permitted');
    assert.strictEqual(updateResult.count, 1, 'own slot should be excluded during check');
    assert.doesNotThrow(() => assertProxyAssignmentAvailable(cappedProxy, testProfiles, 'env-1'));
  });

  check('switching another profile to a full proxy is rejected', () => {
    // env-3 is currently on legacyProxy. Switching to cappedProxy must be rejected
    const switchResult = canAssignProxy(cappedProxy, testProfiles, 'env-3');
    assert.strictEqual(switchResult.ok, false, 'switching to full proxy must be rejected');
    assert.strictEqual(switchResult.code, 'ERR_PROXY_MAX_CONCURRENCY');
    assert.throws(() => assertProxyAssignmentAvailable(cappedProxy, testProfiles, 'env-3'), (err) => {
      return err.code === 'ERR_PROXY_MAX_CONCURRENCY';
    });
  });

  check('store.canAssign and store.assertAssignmentAvailable resolve by proxy ID', () => {
    assert.strictEqual(store.canAssign(cappedProxy.id, testProfiles, 'env-1').ok, true);
    assert.strictEqual(store.canAssign(cappedProxy.id, testProfiles, 'new-env').ok, false);
    assert.throws(() => store.assertAssignmentAvailable(cappedProxy.id, testProfiles, 'new-env'), (err) => {
      return err.code === 'ERR_PROXY_MAX_CONCURRENCY';
    });
  });

  check('profileMatchesProxy correctly discriminates direct, ID-linked, and raw endpoints', () => {
    const dummyProxy = { id: 'd-1', raw: 'socks5://192.168.1.1:1080' };
    assert.strictEqual(profileMatchesProxy({ id: '1', proxyId: 'd-1' }, dummyProxy), true);
    assert.strictEqual(profileMatchesProxy({ id: '2', proxyMeta: { proxy_library_id: 'd-1' } }, dummyProxy), true);
    assert.strictEqual(profileMatchesProxy({ id: '3', proxy: 'socks5://192.168.1.1:1080' }, dummyProxy), true);
    assert.strictEqual(profileMatchesProxy({ id: '4', networkMode: 'direct', proxyId: 'd-1' }, dummyProxy), false);
    assert.strictEqual(profileMatchesProxy({ id: '5', proxyId: 'other', proxy: 'socks5://192.168.1.1:1080' }, dummyProxy), false);
  });

  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });

  const failed = results.filter((entry) => !entry.ok).length;
  console.log(`\nPROXY_CONCURRENCY_SELFTEST ${failed ? 'FAILED' : 'OK'} ${results.length - failed}/${results.length} checks passed\n`);
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error('proxy-concurrency-selftest crashed:', error);
  process.exit(1);
});
