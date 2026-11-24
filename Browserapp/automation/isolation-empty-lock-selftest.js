#!/usr/bin/env node
'use strict';

/**
 * Lock recovery must fail closed while another opener is mid-write, unreadable, or corrupt with unproven ownership; no browser, no network.
 */

const assert = require('assert');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const isolation = require('./isolation');

const results = [];
function record(name, ok, err) {
  results.push({ name, ok, err });
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : `  -> ${err}`}`);
}
async function checkAsync(name, fn) {
  try { await fn(); record(name, true); }
  catch (e) { record(name, false, e?.message || String(e)); }
}

let scratch;
function newRoot(label) {
  return fsp.mkdtemp(path.join(scratch, `${label}-`));
}

function readLock(root) {
  return JSON.parse(fs.readFileSync(path.join(root, '.openbrowser-instance.lock'), 'utf8'));
}
function lockExists(root) {
  return fs.existsSync(path.join(root, '.openbrowser-instance.lock'));
}

(async () => {
  scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'ob-isolation-lock-'));

  // ---------- the exact open()-before-write() race, with a real held handle ----------
  await checkAsync('a real opener parked between open(wx) and write() keeps the lock', async () => {
    const root = await newRoot('repro');
    const file = path.join(root, '.openbrowser-instance.lock');
    // Child takes the real open('wx') lock, parks without writing, and reports the open fd.
    const childScript = `
      const fs = require('fs');
      const file = process.argv[1];
      const fd = fs.openSync(file, 'wx', 0o600);
      process.stdout.write('OPEN\\n');
      process.stdin.on('end', () => { fs.writeSync(fd, JSON.stringify({ profileRoot: require('path').resolve(process.argv[2]), pid: process.pid, token: 'owner-a' })); fs.closeSync(fd); });
      process.stdin.resume();
    `;
    const child = require('child_process').spawn(process.execPath, ['-e', childScript, file, root], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const exited = new Promise((resolve) => child.once('exit', resolve));
    try {
      const opened = await new Promise((resolve, reject) => {
        let out = '';
        const timer = setTimeout(() => reject(new Error('child never reached open()')), 5000);
        child.stdout.on('data', (c) => {
          out += c;
          if (out.includes('OPEN')) { clearTimeout(timer); resolve(true); }
        });
        child.once('error', reject);
        child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`child exited early code=${code}`)); });
      });
      assert.strictEqual(opened, true);
      // The file exists and is genuinely empty right now — a real mid-write window.
      assert.strictEqual(fs.readFileSync(file, 'utf8'), '', 'the opener has not written yet');

      let error = null;
      try { await isolation.acquireProfileLock(root, { profileId: 'p1' }); } catch (e) { error = e; }
      assert.ok(error, 'a second instance must be refused while the first is mid-write');
      assert.strictEqual(error.code, 'PROFILE_LOCKED');
      assert.ok(lockExists(root), 'the live lock must not be deleted');

      // Let the real owner finish; its lock and token are the only ones present.
      child.stdin.end();
      await exited;
      assert.strictEqual(readLock(root).token, 'owner-a', 'the original opener still owns the lock');
    } finally {
      // Any assertion/timeout above must not leave this test's own child hanging.
      try { child.stdin.end(); } catch (_) {}
      const stopped = await Promise.race([
        exited.then(() => true),
        new Promise((resolve) => setTimeout(() => resolve(false), 3000)),
      ]);
      if (!stopped) {
        try { child.kill('SIGKILL'); } catch (_) {}
        await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 1000))]);
      }
    }
  });

  await checkAsync('a whitespace-only lock is rejected the same way', async () => {
    const root = await newRoot('blank');
    await fsp.writeFile(path.join(root, '.openbrowser-instance.lock'), '  \n\t ');
    let error = null;
    try { await isolation.acquireProfileLock(root, { profileId: 'p2' }); } catch (e) { error = e; }
    assert.ok(error, 'blank lock must not be reclaimed');
    assert.strictEqual(error.code, 'PROFILE_LOCKED');
    assert.ok(lockExists(root), 'blank lock must survive');
  });

  // ---------- unreadable lock is fail-closed ----------
  if (process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() !== 0) {
    await checkAsync('an unreadable lock (EACCES) is never removed', async () => {
      const root = await newRoot('eacces');
      const file = path.join(root, '.openbrowser-instance.lock');
      // A non-empty stale-looking body: the point is that we cannot READ it.
      await fsp.writeFile(file, JSON.stringify({ profileRoot: path.resolve(root), pid: 999999, token: 'x' }));
      await fsp.chmod(file, 0o000);
      let error = null;
      try { await isolation.acquireProfileLock(root, { profileId: 'p3' }); } catch (e) { error = e; }
      await fsp.chmod(file, 0o600);
      assert.ok(error, 'an unreadable lock must block, not be reclaimed');
      assert.strictEqual(error.code, 'PROFILE_LOCK_UNRECOVERABLE');
      assert.ok(lockExists(root), 'unreadable lock must remain on disk');
    });

    await checkAsync('the read-error branch is distinct from the parse-error branch', async () => {
      // Guard against a regression that merges both catch blocks again: a
      // read error must not be reported as "malformed".
      const root = await newRoot('distinct');
      const file = path.join(root, '.openbrowser-instance.lock');
      await fsp.writeFile(file, '{ "pid": 1 }');
      await fsp.chmod(file, 0o000);
      let error = null;
      try { await isolation.acquireProfileLock(root, { profileId: 'p4' }); } catch (e) { error = e; }
      await fsp.chmod(file, 0o600);
      assert.ok(error && error.code === 'PROFILE_LOCK_UNRECOVERABLE', `unexpected ${error && error.code}`);
      assert.ok(/cannot be read/i.test(error.message), `message should say unreadable: ${error.message}`);
    });
  } else {
    record('unreadable-lock checks skipped (needs non-root POSIX)', true);
  }

  // ---------- corrupt-but-readable lock is not reclaimed on age alone ----------
  await checkAsync('fresh corrupt JSON with an unknown owner is not reclaimed after 15s of age', async () => {
    const root = await newRoot('corrupt');
    const file = path.join(root, '.openbrowser-instance.lock');
    await fsp.writeFile(file, '{ this is not json');
    // Backdate well past UNKNOWN_STARTUP_LOCK_RECOVERY_MS (15s) but keep it
    // after boot, so only the old "age > 15s" heuristic would have deleted it.
    const old = new Date(Date.now() - 60 * 1000);
    fs.utimesSync(file, old, old);

    let error = null;
    try { await isolation.acquireProfileLock(root, { profileId: 'p5' }); } catch (e) { error = e; }
    assert.ok(error, 'an unprovable owner must fail closed regardless of age');
    assert.strictEqual(error.code, 'PROFILE_LOCK_UNRECOVERABLE');
    assert.ok(lockExists(root), 'corrupt lock must be preserved');
  });

  // ---------- a genuine prior-boot lock is still recoverable ----------
  await checkAsync('a lock provably from a prior boot is reclaimed', async () => {
    const root = await newRoot('priorboot');
    const file = path.join(root, '.openbrowser-instance.lock');
    await fsp.writeFile(file, 'garbage-from-last-boot');
    // mtime before boot (boot = now - uptime) guarantees isFileFromPriorBoot.
    const beforeBoot = new Date(Date.now() - os.uptime() * 1000 - 60 * 1000);
    fs.utimesSync(file, beforeBoot, beforeBoot);

    const owner = await isolation.acquireProfileLock(root, { profileId: 'p6' });
    assert.ok(owner && owner.token, 'the prior-boot lock is reclaimed and replaced');
    assert.strictEqual(readLock(root).profileId, 'p6');
    await isolation.releaseProfileLock(root, owner);
  });

  // ---------- normal dead-owner recovery is unchanged ----------
  await checkAsync('a parsed lock with a dead owner and matching profile is still recovered', async () => {
    const root = await newRoot('deadowner');
    const identityRoot = path.resolve(root);
    const file = path.join(root, '.openbrowser-instance.lock');
    // pid 2^31-1 style dead pid; browserPid null is the "startup crashed" shape
    // but we set a known-dead browserPid so the dead-owner path is unambiguous.
    await fsp.writeFile(file, JSON.stringify({
      profileRoot: identityRoot,
      profileId: 'p7',
      pid: 2147483646,
      browserPid: 2147483645,
      token: 'dead',
      createdAt: new Date(Date.now() - 60 * 1000).toISOString(),
    }));
    const owner = await isolation.acquireProfileLock(root, { profileId: 'p7' });
    assert.ok(owner && owner.token && owner.token !== 'dead');
    assert.strictEqual(readLock(root).pid, process.pid);
    await isolation.releaseProfileLock(root, owner);
    assert.strictEqual(lockExists(root), false, 'release removes the lock');
  });

  // ---------- still exclusive for a healthy owner ----------
  await checkAsync('a live owner keeps exclusivity and only the token holder releases', async () => {
    const root = await newRoot('exclusive');
    const owner = await isolation.acquireProfileLock(root, { profileId: 'p8' });

    let second = null;
    try { await isolation.acquireProfileLock(root, { profileId: 'p8' }); } catch (e) { second = e; }
    assert.ok(second, 'a second acquire by the same live process must be refused');
    assert.strictEqual(second.code, 'PROFILE_LOCKED');

    // A wrong token must not release somebody else's lock.
    const released = await isolation.releaseProfileLock(root, { pid: owner.pid, token: 'other' });
    assert.strictEqual(released, false, 'wrong token cannot release');
    assert.ok(lockExists(root));

    assert.strictEqual(await isolation.releaseProfileLock(root, owner), true);
    assert.strictEqual(lockExists(root), false);
  });

  // ---------- update is token-gated ----------
  await checkAsync('updateProfileLock refuses a mismatched token and accepts the owner', async () => {
    const root = await newRoot('update');
    const owner = await isolation.acquireProfileLock(root, { profileId: 'p9' });
    assert.strictEqual(await isolation.updateProfileLock(root, { pid: owner.pid, token: 'nope' }, { browserPid: 4242 }), false);
    const updated = await isolation.updateProfileLock(root, owner, { browserPid: 4242 });
    assert.ok(updated && updated.browserPid === 4242, 'owner token can bind the browser pid');
    await isolation.releaseProfileLock(root, owner);
  });

  // ================= report =================
  await fsp.rm(scratch, { recursive: true, force: true }).catch(() => {});
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  console.log(`\nISOLATION_EMPTY_LOCK_SELFTEST ${failed.length ? 'FAILED' : 'OK'} ${passed}/${results.length}`);
  if (failed.length) process.exitCode = 1;
})();
