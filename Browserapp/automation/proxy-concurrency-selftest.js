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

const { ProxyStore } = require('./proxy-store');
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

  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });

  const failed = results.filter((entry) => !entry.ok).length;
  console.log(`\nPROXY_CONCURRENCY_SELFTEST ${failed ? 'FAILED' : 'OK'} ${results.length - failed}/${results.length} checks passed\n`);
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error('proxy-concurrency-selftest crashed:', error);
  process.exit(1);
});
