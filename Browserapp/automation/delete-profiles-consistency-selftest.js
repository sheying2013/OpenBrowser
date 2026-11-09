'use strict';

const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { BrowserEngine } = require('../engine');

async function seedProfile(engine, id, options = {}) {
  const profile = engine.sanitizeProfile({
    id,
    name: options.name || `Profile ${id}`,
    number: options.number || 1,
    cookies: options.cookies || `sid=${id}`,
  });
  engine.profiles.set(id, profile);
  engine.assignments.set(id, new Set(options.extensions || ['ext-1']));
  engine.networkInfo.set(id, { ip: options.ip || '198.51.100.10' });

  if (engine.usingSqlite && engine.sqliteStore && options.persistToDb !== false) {
    engine.sqliteStore.saveProfiles([profile]);
    engine.sqliteStore.setAssignments(id, [...engine.assignments.get(id)]);
  }

  if (options.withDisk !== false) {
    const dir = engine.profileRoot(id);
    await fsp.mkdir(path.join(dir, 'Default'), { recursive: true });
    await fsp.writeFile(path.join(dir, 'Default', 'Preferences'), JSON.stringify({ marker: id }), 'utf8');
    await fsp.writeFile(path.join(dir, 'marker.txt'), `data:${id}`, 'utf8');
  }
  return profile;
}

function listDeleteStagingDirs(profileDataRoot) {
  if (!fs.existsSync(profileDataRoot)) return [];
  return fs.readdirSync(profileDataRoot).filter((name) => name.startsWith('.ob-del-'));
}

function makeManifest(overrides = {}) {
  const state = overrides.state || 'staging';
  const base = {
    kind: 'openbrowser-delete-staging',
    version: 1,
    pid: 99999999,
    startedAt: new Date(Date.now() - 60000).toISOString(),
    state,
    ids: ['p1'],
  };
  if (state === 'committed' && !('committedAt' in overrides)) {
    base.committedAt = new Date(Date.now() - 30000).toISOString();
  }
  return { ...base, ...overrides };
}

async function createIsolatedEngine(tempRoot, options = {}) {
  const userData = path.join(tempRoot, options.subdir || 'userData');
  const profileDataRoot = path.join(userData, 'browser-profiles-v2');
  const dbPath = path.join(userData, 'openbrowser-data.db');
  await fsp.mkdir(userData, { recursive: true });

  const app = { getPath: () => userData };
  const engine = new BrowserEngine(app, {
    profileDataRoot,
    dbPath,
    auditLogs: false,
  });

  if (options.init !== false) {
    await engine.init(null);
  }
  return { engine, userData, profileDataRoot, dbPath };
}

async function testHappyPathSqlite(root) {
  console.log('\n--- [Test 1] Happy Path Batch Delete (SQLite) ---');
  const { engine, profileDataRoot } = await createIsolatedEngine(root, { subdir: 't1-happy' });
  try {
    await seedProfile(engine, 'p1', { number: 1, withDisk: true });
    await seedProfile(engine, 'p2', { number: 2, withDisk: true });
    await seedProfile(engine, 'p3', { number: 3, withDisk: false });
    await seedProfile(engine, 'p4', { number: 4, withDisk: true });

    const stoppedIds = [];
    engine.running.set('p1', { pid: 999991 });
    engine.stop = async (id) => {
      stoppedIds.push(id);
      engine.running.delete(id);
      return { id, running: false };
    };

    const events = [];
    engine.on((evt) => events.push(evt));

    const res = await engine.deleteProfiles(['p1', 'p2', 'p3', 'p1', 'nonexistent'], true);
    assert.equal(res.success, true);
    assert.equal(res.deleted, 3);
    assert.equal(res.stopped, 1);
    assert.equal(res.dataDeleted, true);
    assert.deepEqual(res.ids, ['p1', 'p2', 'p3']);
    assert.equal('cleanupPending' in res, false);
    assert.deepEqual(stoppedIds, ['p1']);

    for (const id of ['p1', 'p2', 'p3']) {
      assert.equal(engine.profiles.has(id), false, `${id} removed from memory`);
      assert.equal(engine.assignments.has(id), false, `${id} assignments removed`);
      assert.equal(engine.networkInfo.has(id), false, `${id} networkInfo removed`);
      assert.equal(engine.sqliteStore.getProfile(id), null, `${id} removed from SQLite`);
      assert.equal(fs.existsSync(engine.profileRoot(id)), false, `${id} disk dir removed`);
    }

    assert.equal(engine.profiles.has('p4'), true, 'untouched profile remains in memory');
    assert.ok(engine.sqliteStore.getProfile('p4'), 'untouched profile remains in SQLite');
    assert.equal(fs.readFileSync(path.join(engine.profileRoot('p4'), 'marker.txt'), 'utf8'), 'data:p4');
    assert.deepEqual(listDeleteStagingDirs(profileDataRoot), [], 'no leftover staging dirs');

    const deleteEvents = events.filter((e) => e.type === 'profiles' && e.action === 'delete');
    assert.equal(deleteEvents.length, 1);
    assert.deepEqual(deleteEvents[0].ids, ['p1', 'p2', 'p3']);
    console.log('  PASS  Batch delete cleans SQLite, memory, and disk with zero staging leftovers');
  } finally {
    try { engine.sqliteStore?.close(); } catch (_) {}
  }
}

async function testRetainData(root) {
  console.log('\n--- [Test 2] Delete Metadata Only (deleteData = false) ---');
  const { engine, profileDataRoot } = await createIsolatedEngine(root, { subdir: 't2-retain' });
  try {
    await seedProfile(engine, 'r1', { number: 1, withDisk: true });
    const res = await engine.deleteProfiles(['r1'], false);
    assert.equal(res.success, true);
    assert.equal(res.deleted, 1);
    assert.equal(res.dataDeleted, false);
    assert.equal(engine.profiles.has('r1'), false);
    assert.equal(engine.sqliteStore.getProfile('r1'), null);
    assert.equal(fs.readFileSync(path.join(engine.profileRoot('r1'), 'marker.txt'), 'utf8'), 'data:r1');
    assert.deepEqual(listDeleteStagingDirs(profileDataRoot), []);
    console.log('  PASS  deleteData=false deletes DB/memory while retaining browser directory');
  } finally {
    try { engine.sqliteStore?.close(); } catch (_) {}
  }
}

async function testSqliteFailureRollback(root) {
  console.log('\n--- [Test 3] SQLite Commit Failure Rollback ---');
  const { engine, profileDataRoot } = await createIsolatedEngine(root, { subdir: 't3-db-fail' });
  try {
    await seedProfile(engine, 'd1', { number: 1, withDisk: true });
    await seedProfile(engine, 'd2', { number: 2, withDisk: true });
    await seedProfile(engine, 'd3', { number: 3, withDisk: false });

    const events = [];
    engine.on((evt) => events.push(evt));

    const origDelete = engine.sqliteStore.deleteProfiles.bind(engine.sqliteStore);
    engine.sqliteStore.deleteProfiles = () => {
      const err = new Error('SQLITE_IOERR: synthetic db commit failure');
      err.code = 'SQLITE_IOERR';
      throw err;
    };

    try {
      await assert.rejects(engine.deleteProfiles(['d1', 'd2', 'd3'], true), /SQLITE_IOERR/);
    } finally {
      engine.sqliteStore.deleteProfiles = origDelete;
    }

    for (const id of ['d1', 'd2', 'd3']) {
      assert.equal(engine.profiles.has(id), true, `${id} must remain in memory`);
      assert.ok(engine.assignments.get(id)?.has('ext-1'), `${id} assignments must remain`);
      assert.equal(engine.networkInfo.get(id)?.ip, '198.51.100.10', `${id} networkInfo must remain`);
      assert.ok(engine.sqliteStore.getProfile(id), `${id} must remain in SQLite`);
    }
    assert.equal(fs.readFileSync(path.join(engine.profileRoot('d1'), 'marker.txt'), 'utf8'), 'data:d1');
    assert.equal(fs.readFileSync(path.join(engine.profileRoot('d2'), 'marker.txt'), 'utf8'), 'data:d2');
    assert.deepEqual(listDeleteStagingDirs(profileDataRoot), [], 'staging dir cleaned after rollback');
    assert.equal(events.filter((e) => e.type === 'profiles' && e.action === 'delete').length, 0);
    console.log('  PASS  SQLite commit failure atomically restores all staged directories and preserves memory/DB');
  } finally {
    try { engine.sqliteStore?.close(); } catch (_) {}
  }
}

async function testLegacyJsonPersistRollback(root) {
  console.log('\n--- [Test 4] Legacy JSON Persist Failure Rollback ---');
  const { engine, profileDataRoot } = await createIsolatedEngine(root, { subdir: 't4-json-fail', init: false });
  engine.usingSqlite = false;
  engine.sqliteStore = null;

  await seedProfile(engine, 'j1', { number: 1, withDisk: true, persistToDb: false });
  await seedProfile(engine, 'j2', { number: 2, withDisk: true, persistToDb: false });
  await engine.persist();

  const origPersist = engine.persist.bind(engine);
  engine.persist = async () => {
    const err = new Error('ENOSPC: synthetic disk full on persist');
    err.code = 'ENOSPC';
    throw err;
  };

  try {
    await assert.rejects(engine.deleteProfiles(['j1', 'j2'], true), /ENOSPC/);
  } finally {
    engine.persist = origPersist;
  }

  for (const id of ['j1', 'j2']) {
    assert.equal(engine.profiles.has(id), true, `${id} restored in memory`);
    assert.ok(engine.assignments.get(id)?.has('ext-1'), `${id} assignments restored`);
    assert.equal(engine.networkInfo.get(id)?.ip, '198.51.100.10', `${id} networkInfo restored`);
    assert.equal(fs.readFileSync(path.join(engine.profileRoot(id), 'marker.txt'), 'utf8'), `data:${id}`);
  }
  assert.deepEqual(listDeleteStagingDirs(profileDataRoot), []);

  const stateBackup = JSON.parse(JSON.stringify(
    await require('../engine/state-storage').readEngineStateCandidate(engine.stateFile)
  ));
  assert.deepEqual(stateBackup.saved.profiles.map((p) => p.id).sort(), ['j1', 'j2']);
  console.log('  PASS  Legacy JSON persist failure restores memory, staged directories, and state file');
}

async function testMidwayStagingFailureRollback(root) {
  console.log('\n--- [Test 5] Mid-way Staging Failure Rollback (Item 2 of 3 fails rename) ---');
  const { engine, profileDataRoot } = await createIsolatedEngine(root, { subdir: 't5-mid-stage' });
  try {
    await seedProfile(engine, 'm1', { number: 1, withDisk: true });
    await seedProfile(engine, 'm2', { number: 2, withDisk: true });
    await seedProfile(engine, 'm3', { number: 3, withDisk: true });

    const origRename = fsp.rename;
    fsp.rename = async (src, dst) => {
      if (path.resolve(src) === path.resolve(engine.profileRoot('m2')) && path.basename(path.dirname(dst)).startsWith('.ob-del-')) {
        const err = new Error('EIO: synthetic midway rename failure on m2');
        err.code = 'EIO';
        throw err;
      }
      return origRename(src, dst);
    };

    try {
      await assert.rejects(engine.deleteProfiles(['m1', 'm2', 'm3'], true), /synthetic midway rename failure/);
    } finally {
      fsp.rename = origRename;
    }

    for (const id of ['m1', 'm2', 'm3']) {
      assert.equal(engine.profiles.has(id), true, `${id} remains in memory`);
      assert.ok(engine.sqliteStore.getProfile(id), `${id} remains in SQLite`);
      assert.equal(fs.readFileSync(path.join(engine.profileRoot(id), 'marker.txt'), 'utf8'), `data:${id}`);
    }
    assert.deepEqual(listDeleteStagingDirs(profileDataRoot), [], 'staging dir cleaned after midway rollback');
    console.log('  PASS  Mid-way staging failure rolls back already-staged m1 and keeps m1/m2/m3 consistent');
  } finally {
    try { engine.sqliteStore?.close(); } catch (_) {}
  }
}

async function testPostCommitCleanupFailureAndDeferredRecovery(root) {
  console.log('\n--- [Test 6] Post-Commit Cleanup Failure + Deferred Recovery ---');
  const { engine, profileDataRoot } = await createIsolatedEngine(root, { subdir: 't6-post-rm' });
  try {
    await seedProfile(engine, 'c1', { number: 1, withDisk: true });
    await seedProfile(engine, 'c2', { number: 2, withDisk: true });

    const origRm = fsp.rm;
    fsp.rm = async (target, opts) => {
      if (path.basename(target) === 'c2' && path.basename(path.dirname(target)).startsWith('.ob-del-')) {
        const err = new Error('EIO: synthetic post-commit rm failure on c2');
        err.code = 'EIO';
        throw err;
      }
      return origRm(target, opts);
    };

    let res;
    try {
      res = await engine.deleteProfiles(['c1', 'c2'], true);
    } finally {
      fsp.rm = origRm;
    }

    assert.equal(res.success, true);
    assert.equal(res.deleted, 2);
    assert.equal(res.cleanupPending, true);
    assert.equal(engine.profiles.has('c1'), false);
    assert.equal(engine.profiles.has('c2'), false);
    assert.equal(engine.sqliteStore.getProfile('c1'), null);
    assert.equal(engine.sqliteStore.getProfile('c2'), null);
    assert.equal(fs.existsSync(engine.profileRoot('c1')), false);
    assert.equal(fs.existsSync(engine.profileRoot('c2')), false);

    const stagingDirs = listDeleteStagingDirs(profileDataRoot);
    assert.equal(stagingDirs.length, 1, 'committed staging dir retained when c2 cleanup deferred');
    const leftoverDir = path.join(profileDataRoot, stagingDirs[0]);
    assert.equal(fs.existsSync(path.join(leftoverDir, 'c1')), false, 'c1 already removed');
    assert.equal(fs.existsSync(path.join(leftoverDir, 'c2')), true, 'c2 remains inside committed staging dir');
    const manifest = JSON.parse(fs.readFileSync(path.join(leftoverDir, '.manifest.json'), 'utf8'));
    assert.equal(manifest.kind, 'openbrowser-delete-staging');
    assert.equal(manifest.state, 'committed');
    assert.ok(manifest.committedAt);

    const cleanupRes = await engine.deleteProfiles([], true);
    assert.equal(cleanupRes.success, true);
    assert.deepEqual(listDeleteStagingDirs(profileDataRoot), [], 'deferred committed staging dir cleaned on next run');
    console.log('  PASS  Post-commit cleanup failure keeps DB/profileRoot consistent and cleans up on next run');
  } finally {
    try { engine.sqliteStore?.close(); } catch (_) {}
  }
}

async function testRealChildSigkillPreCommitAndPostCommit(root) {
  console.log('\n--- [Test 7] Real Child SIGKILL (kill -9) Recovery via init() ---');
  const engineJsPath = path.resolve(__dirname, '../engine.js');

  // 7a. SIGKILL after staging all directories, BEFORE SQLite commit -> init() restores immediately!
  {
    const { engine, userData, profileDataRoot, dbPath } = await createIsolatedEngine(root, { subdir: 't7a-sigkill-pre' });
    await seedProfile(engine, 'k1', { number: 1, withDisk: true });
    await seedProfile(engine, 'k2', { number: 2, withDisk: true });
    engine.sqliteStore.close();

    const workerCode = `
      const { BrowserEngine } = require(${JSON.stringify(engineJsPath)});
      (async () => {
        const engine = new BrowserEngine(
          { getPath: () => ${JSON.stringify(userData)} },
          { profileDataRoot: ${JSON.stringify(profileDataRoot)}, dbPath: ${JSON.stringify(dbPath)}, auditLogs: false }
        );
        await engine.init(null);
        engine.sqliteStore.deleteProfiles = () => {
          process.stdout.write('STAGED_BEFORE_DB\\n');
          return new Promise(() => {});
        };
        engine.deleteProfiles(['k1', 'k2'], true);
      })();
    `;

    const child = cp.spawn(process.execPath, ['-e', workerCode], { stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((resolve, reject) => {
      let stderr = '';
      child.stderr.on('data', (d) => { stderr += d.toString(); });
      child.stdout.on('data', (d) => {
        if (d.toString().includes('STAGED_BEFORE_DB')) resolve();
      });
      child.on('exit', (code) => reject(new Error(`Worker exited early (${code}): ${stderr}`)));
    });

    child.kill('SIGKILL');
    await new Promise((resolve) => child.on('exit', resolve));

    assert.equal(listDeleteStagingDirs(profileDataRoot).length, 1, 'staging dir exists after SIGKILL');
    assert.equal(fs.existsSync(path.join(profileDataRoot, 'k1')), false);
    assert.equal(fs.existsSync(path.join(profileDataRoot, 'k2')), false);

    // Restart engine via init() ONLY (without calling deleteProfiles!)
    const { engine: recoveredEngine } = await createIsolatedEngine(root, { subdir: 't7a-sigkill-pre' });
    try {
      assert.ok(recoveredEngine.sqliteStore.getProfile('k1'));
      assert.ok(recoveredEngine.sqliteStore.getProfile('k2'));
      assert.deepEqual(listDeleteStagingDirs(profileDataRoot), [], 'init() immediately restored and removed staging dir');
      assert.equal(fs.readFileSync(path.join(recoveredEngine.profileRoot('k1'), 'marker.txt'), 'utf8'), 'data:k1');
      assert.equal(fs.readFileSync(path.join(recoveredEngine.profileRoot('k2'), 'marker.txt'), 'utf8'), 'data:k2');
      console.log('  PASS  SIGKILL before DB commit is recovered immediately during engine.init()');
    } finally {
      try { recoveredEngine.sqliteStore?.close(); } catch (_) {}
    }
  }

  // 7b. SIGKILL after SQLite commit & manifest committed, BEFORE rm cleanup -> init() cleans without harming recreated same-id profile
  {
    const { engine, userData, profileDataRoot, dbPath } = await createIsolatedEngine(root, { subdir: 't7b-sigkill-post' });
    await seedProfile(engine, 'k1', { number: 1, withDisk: true });
    await seedProfile(engine, 'k2', { number: 2, withDisk: true });
    engine.sqliteStore.close();

    const workerCode = `
      const fsp = require('node:fs/promises');
      const path = require('node:path');
      const { BrowserEngine } = require(${JSON.stringify(engineJsPath)});
      (async () => {
        const engine = new BrowserEngine(
          { getPath: () => ${JSON.stringify(userData)} },
          { profileDataRoot: ${JSON.stringify(profileDataRoot)}, dbPath: ${JSON.stringify(dbPath)}, auditLogs: false }
        );
        await engine.init(null);
        const origRm = fsp.rm;
        fsp.rm = async (target, opts) => {
          if (path.basename(path.dirname(target)).startsWith('.ob-del-') && path.basename(target) === 'k1') {
            process.stdout.write('COMMITTED_BEFORE_RM\\n');
            return new Promise(() => {});
          }
          return origRm(target, opts);
        };
        engine.deleteProfiles(['k1', 'k2'], true);
      })();
    `;

    const child = cp.spawn(process.execPath, ['-e', workerCode], { stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((resolve, reject) => {
      let stderr = '';
      child.stderr.on('data', (d) => { stderr += d.toString(); });
      child.stdout.on('data', (d) => {
        if (d.toString().includes('COMMITTED_BEFORE_RM')) resolve();
      });
      child.on('exit', (code) => reject(new Error(`Worker exited early (${code}): ${stderr}`)));
    });

    child.kill('SIGKILL');
    await new Promise((resolve) => child.on('exit', resolve));

    assert.equal(listDeleteStagingDirs(profileDataRoot).length, 1, 'committed staging dir exists after SIGKILL');

    // Create fresh k1 directory BEFORE init() runs to verify committed cleanup never touches live k1
    await fsp.mkdir(path.join(profileDataRoot, 'k1'), { recursive: true });
    await fsp.writeFile(path.join(profileDataRoot, 'k1', 'marker.txt'), 'fresh:k1', 'utf8');

    const { engine: recoveredEngine } = await createIsolatedEngine(root, { subdir: 't7b-sigkill-post' });
    try {
      assert.equal(recoveredEngine.sqliteStore.getProfile('k1'), null);
      assert.equal(recoveredEngine.sqliteStore.getProfile('k2'), null);
      assert.deepEqual(listDeleteStagingDirs(profileDataRoot), [], 'init() immediately cleaned committed leftover');
      assert.equal(
        fs.readFileSync(path.join(recoveredEngine.profileRoot('k1'), 'marker.txt'), 'utf8'),
        'fresh:k1',
        'committed staging cleanup must never overwrite or delete newly created profile with same id'
      );
      console.log('  PASS  SIGKILL after DB commit is cleaned during init() without harming recreated same-id dir');
    } finally {
      try { recoveredEngine.sqliteStore?.close(); } catch (_) {}
    }
  }
}

async function testSimulatedCrashEdgeCasesAndLivePid(root) {
  console.log('\n--- [Test 8] Crash Edge Cases (Window Before Manifest Commit, Conflict, Live PID) ---');
  const { engine, profileDataRoot } = await createIsolatedEngine(root, { subdir: 't8-edges' });
  try {
    await seedProfile(engine, 'alive-1', { number: 1, withDisk: false });
    const orphanBatch = path.join(profileDataRoot, '.ob-del-deadbatch1');
    await fsp.mkdir(path.join(orphanBatch, 'alive-1'), { recursive: true });
    await fsp.writeFile(path.join(orphanBatch, 'alive-1', 'marker.txt'), 'recovered-alive', 'utf8');
    await fsp.mkdir(path.join(orphanBatch, 'ghost-1'), { recursive: true });
    await fsp.writeFile(path.join(orphanBatch, 'ghost-1', 'marker.txt'), 'should-delete', 'utf8');
    await fsp.writeFile(path.join(orphanBatch, '.manifest.json'), JSON.stringify(makeManifest({
      state: 'staging',
      ids: ['alive-1', 'ghost-1'],
    })), 'utf8');

    // Conflict case: alive profile exists BOTH at profileRoot and in staging
    await seedProfile(engine, 'conflict-1', { number: 2, withDisk: true });
    await fsp.writeFile(path.join(engine.profileRoot('conflict-1'), 'marker.txt'), 'live-copy', 'utf8');
    const conflictBatch = path.join(profileDataRoot, '.ob-del-conflict1');
    await fsp.mkdir(path.join(conflictBatch, 'conflict-1'), { recursive: true });
    await fsp.writeFile(path.join(conflictBatch, 'conflict-1', 'marker.txt'), 'old-staged-copy', 'utf8');
    await fsp.writeFile(path.join(conflictBatch, '.manifest.json'), JSON.stringify(makeManifest({
      pid: 99999998,
      state: 'staging',
      ids: ['conflict-1'],
    })), 'utf8');

    // Live external process owning a staging dir must NOT be touched while alive
    const sleeper = cp.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { stdio: 'ignore' });
    const liveBatch = path.join(profileDataRoot, '.ob-del-liveowner');
    await fsp.mkdir(path.join(liveBatch, 'live-p'), { recursive: true });
    await fsp.writeFile(path.join(liveBatch, '.manifest.json'), JSON.stringify(makeManifest({
      pid: sleeper.pid,
      startedAt: new Date().toISOString(),
      committedAt: new Date().toISOString(),
      state: 'committed',
      ids: ['live-p'],
    })), 'utf8');

    try {
      await engine.recoverDeleteStagingLeftovers();

      assert.equal(fs.existsSync(orphanBatch), false, 'mixed staging batch reconciled and removed');
      assert.equal(fs.readFileSync(path.join(engine.profileRoot('alive-1'), 'marker.txt'), 'utf8'), 'recovered-alive');
      assert.equal(fs.existsSync(engine.profileRoot('ghost-1')), false, 'deleted ghost profile cleaned up');

      assert.equal(fs.readFileSync(path.join(engine.profileRoot('conflict-1'), 'marker.txt'), 'utf8'), 'live-copy');
      assert.equal(
        fs.readFileSync(path.join(conflictBatch, 'conflict-1', 'marker.txt'), 'utf8'),
        'old-staged-copy',
        'conflict preserves both copies safely'
      );

      assert.equal(fs.existsSync(liveBatch), true, 'live external process staging dir must not be deleted');
    } finally {
      sleeper.kill('SIGKILL');
      await new Promise((resolve) => sleeper.on('exit', resolve));
    }

    await engine.recoverDeleteStagingLeftovers();
    assert.equal(fs.existsSync(liveBatch), false, 'dead external process staging dir cleaned up');
    console.log('  PASS  Window recovery, conflict preservation, and live-PID exclusion verified');
  } finally {
    try { engine.sqliteStore?.close(); } catch (_) {}
  }
}

async function testIsolationSymlinkConcurrencyAndPartialRollback(root) {
  console.log('\n--- [Test 9] Symlink Isolation, Concurrent Calls, & Partial Rollback ---');
  const { engine, profileDataRoot } = await createIsolatedEngine(root, { subdir: 't9-iso-conc' });
  try {
    await seedProfile(engine, 'valid-1', { number: 1, withDisk: true });
    await seedProfile(engine, 'sym-1', { number: 2, withDisk: false });
    const outsideTarget = path.join(root, 'outside-secret');
    await fsp.mkdir(outsideTarget, { recursive: true });
    await fsp.writeFile(path.join(outsideTarget, 'secret.txt'), 'keep-me', 'utf8');
    await fsp.symlink(outsideTarget, engine.profileRoot('sym-1'));

    await assert.rejects(engine.deleteProfiles(['valid-1', 'sym-1'], true), /Isolation error/);
    assert.equal(engine.profiles.has('valid-1'), true);
    assert.ok(engine.sqliteStore.getProfile('valid-1'));
    assert.equal(fs.readFileSync(path.join(engine.profileRoot('valid-1'), 'marker.txt'), 'utf8'), 'data:valid-1');
    assert.equal(fs.readFileSync(path.join(outsideTarget, 'secret.txt'), 'utf8'), 'keep-me');
    await fsp.unlink(engine.profileRoot('sym-1'));
    engine.profiles.delete('sym-1');
    engine.sqliteStore.deleteProfiles(['sym-1']);

    await seedProfile(engine, 'conc-a', { number: 3, withDisk: true });
    await seedProfile(engine, 'conc-b', { number: 4, withDisk: true });
    const [resA, resB] = await Promise.all([
      engine.deleteProfiles(['conc-a'], true),
      engine.deleteProfiles(['conc-b'], true),
    ]);
    assert.equal(resA.deleted, 1);
    assert.equal(resB.deleted, 1);
    assert.deepEqual(listDeleteStagingDirs(profileDataRoot), []);

    await seedProfile(engine, 'rb-1', { number: 5, withDisk: true });
    await seedProfile(engine, 'rb-2', { number: 6, withDisk: true });

    const origDelete = engine.sqliteStore.deleteProfiles.bind(engine.sqliteStore);
    const origRename = fsp.rename;
    engine.sqliteStore.deleteProfiles = () => {
      throw new Error('synthetic db error for partial rollback');
    };
    fsp.rename = async (src, dst) => {
      if (path.basename(path.dirname(src)).startsWith('.ob-del-') && path.basename(src) === 'rb-1') {
        const err = new Error('EIO: synthetic rollback failure on rb-1');
        err.code = 'EIO';
        throw err;
      }
      return origRename(src, dst);
    };

    try {
      await assert.rejects(engine.deleteProfiles(['rb-1', 'rb-2'], true), /synthetic db error/);
    } finally {
      engine.sqliteStore.deleteProfiles = origDelete;
      fsp.rename = origRename;
    }

    assert.equal(fs.readFileSync(path.join(engine.profileRoot('rb-2'), 'marker.txt'), 'utf8'), 'data:rb-2', 'rb-2 restored despite rb-1 rollback failure');
    assert.equal(listDeleteStagingDirs(profileDataRoot).length, 1, 'rb-1 preserved in staging dir for retry');

    await engine.recoverDeleteStagingLeftovers();
    assert.equal(fs.readFileSync(path.join(engine.profileRoot('rb-1'), 'marker.txt'), 'utf8'), 'data:rb-1', 'rb-1 restored by subsequent recovery');
    assert.deepEqual(listDeleteStagingDirs(profileDataRoot), []);
    console.log('  PASS  Symlink isolation, concurrent batch serialization, and partial rollback verified');
  } finally {
    try { engine.sqliteStore?.close(); } catch (_) {}
  }
}

async function testRecoveryBeforeStartAndJsonInit(root) {
  console.log('\n--- [Test 10] Recovery Before engine.start() & Legacy JSON init() ---');

  // 10a. Recovery inside start() BEFORE profileRoot is created or validated
  {
    const { engine, profileDataRoot } = await createIsolatedEngine(root, { subdir: 't10a-start-recover' });
    try {
      const profile = await seedProfile(engine, 'start-rec-1', { number: 1, withDisk: false });
      const batchDir = path.join(profileDataRoot, '.ob-del-crashbeforestart');
      await fsp.mkdir(path.join(batchDir, 'start-rec-1', 'Default'), { recursive: true });
      await fsp.writeFile(path.join(batchDir, 'start-rec-1', 'marker.txt'), 'pre-crash-cookies', 'utf8');
      await fsp.writeFile(path.join(batchDir, '.manifest.json'), JSON.stringify(makeManifest({
        state: 'staging',
        ids: ['start-rec-1'],
      })), 'utf8');

      assert.equal(fs.existsSync(engine.profileRoot('start-rec-1')), false, 'profileRoot missing before start()');

      let sawRestoredBeforeBrowserLaunch = false;
      engine.prepareProfileProxyForStart = async (p) => {
        // By the time start() reaches prepareProfileProxyForStart / chooseBrowser / profileRoot creation,
        // staged directory MUST already be restored to profileRoot!
        if (fs.existsSync(path.join(engine.profileRoot('start-rec-1'), 'marker.txt'))) {
          sawRestoredBeforeBrowserLaunch = fs.readFileSync(path.join(engine.profileRoot('start-rec-1'), 'marker.txt'), 'utf8') === 'pre-crash-cookies';
        }
        throw new Error('SYNTHETIC_STOP_BEFORE_BROWSER');
      };

      await assert.rejects(engine.start(profile), /SYNTHETIC_STOP_BEFORE_BROWSER/);
      assert.equal(sawRestoredBeforeBrowserLaunch, true, 'start() must restore staged profile dir before launching/creating profileRoot');
      assert.deepEqual(listDeleteStagingDirs(profileDataRoot), [], 'staging dir cleaned up by start()');
    } finally {
      try { engine.sqliteStore?.close(); } catch (_) {}
    }
  }

  // 10b. If restoring target profile inside start() fails, start() refuses to proceed with empty dir
  {
    const { engine, profileDataRoot } = await createIsolatedEngine(root, { subdir: 't10b-start-failclosed' });
    try {
      const profile = await seedProfile(engine, 'start-lock-1', { number: 1, withDisk: false });
      const batchDir = path.join(profileDataRoot, '.ob-del-cantrestore');
      await fsp.mkdir(path.join(batchDir, 'start-lock-1'), { recursive: true });
      await fsp.writeFile(path.join(batchDir, 'start-lock-1', 'marker.txt'), 'locked-data', 'utf8');
      await fsp.writeFile(path.join(batchDir, '.manifest.json'), JSON.stringify(makeManifest({
        state: 'staging',
        ids: ['start-lock-1'],
      })), 'utf8');

      const origRename = fsp.rename;
      fsp.rename = async (src, dst) => {
        if (path.basename(src) === 'start-lock-1' && path.basename(path.dirname(src)) === '.ob-del-cantrestore') {
          const err = new Error('EIO: cannot restore');
          err.code = 'EIO';
          throw err;
        }
        return origRename(src, dst);
      };
      try {
        await assert.rejects(engine.start(profile), /unrecovered staging data/);
      } finally {
        fsp.rename = origRename;
      }
      assert.equal(fs.existsSync(engine.profileRoot('start-lock-1')), false, 'must not create empty dir when restore failed');
      assert.equal(fs.readFileSync(path.join(batchDir, 'start-lock-1', 'marker.txt'), 'utf8'), 'locked-data');
    } finally {
      try { engine.sqliteStore?.close(); } catch (_) {}
    }
  }

  // 10c. Legacy JSON mode init() recovery (when SQLite is unsupported / JSON stateFile exists without dbFile)
  {
    const { ProfileStoreSqlite } = require('../automation/profile-store-sqlite');
    const userData = path.join(root, 't10c-json-init');
    const profileDataRoot = path.join(userData, 'browser-profiles-v2');
    await fsp.mkdir(profileDataRoot, { recursive: true });
    const engine1 = new BrowserEngine({ getPath: () => userData }, { profileDataRoot, auditLogs: false });
    engine1.usingSqlite = false;
    await seedProfile(engine1, 'json-alive', { number: 1, withDisk: false, persistToDb: false });
    await engine1.persist();

    // Pre-commit staging for json-alive + committed leftover for json-deleted
    const b1 = path.join(profileDataRoot, '.ob-del-jsonstage');
    await fsp.mkdir(path.join(b1, 'json-alive'), { recursive: true });
    await fsp.writeFile(path.join(b1, 'json-alive', 'marker.txt'), 'json-restored', 'utf8');
    await fsp.writeFile(path.join(b1, '.manifest.json'), JSON.stringify(makeManifest({
      state: 'staging',
      ids: ['json-alive'],
    })), 'utf8');

    const b2 = path.join(profileDataRoot, '.ob-del-jsoncommit');
    await fsp.mkdir(path.join(b2, 'json-deleted'), { recursive: true });
    await fsp.writeFile(path.join(b2, 'json-deleted', 'marker.txt'), 'json-obsolete', 'utf8');
    await fsp.writeFile(path.join(b2, '.manifest.json'), JSON.stringify(makeManifest({
      state: 'committed',
      ids: ['json-deleted'],
    })), 'utf8');

    const origIsSupported = ProfileStoreSqlite.isSupported;
    ProfileStoreSqlite.isSupported = () => false;
    try {
      const engine2 = new BrowserEngine({ getPath: () => userData }, { profileDataRoot, auditLogs: false });
      await engine2.init(null);
      assert.equal(engine2.usingSqlite, false);
      assert.equal(fs.readFileSync(path.join(engine2.profileRoot('json-alive'), 'marker.txt'), 'utf8'), 'json-restored');
      assert.equal(fs.existsSync(b1), false);
      assert.equal(fs.existsSync(b2), false);
    } finally {
      ProfileStoreSqlite.isSupported = origIsSupported;
    }
  }

  console.log('  PASS  Recovery runs before start() and during JSON/SQLite init()');
}

async function testUnknownStagingDirsAndStrictManifestValidation(root) {
  console.log('\n--- [Test 11] Unknown .ob-del-* Directories & Strict Manifest/Target Protection ---');
  const { engine, profileDataRoot } = await createIsolatedEngine(root, { subdir: 't11-unknown-protection' });
  try {
    await fsp.mkdir(profileDataRoot, { recursive: true });

    // 1. Directory starting with .ob-del- WITHOUT .manifest.json
    const noManifestDir = path.join(profileDataRoot, '.ob-del-userbackup');
    await fsp.mkdir(path.join(noManifestDir, 'important-folder'), { recursive: true });
    await fsp.writeFile(path.join(noManifestDir, 'important-folder', 'user.txt'), 'precious-1', 'utf8');

    // 2. Directory with corrupt JSON .manifest.json
    const corruptManifestDir = path.join(profileDataRoot, '.ob-del-corruptjson');
    await fsp.mkdir(path.join(corruptManifestDir, 'p1'), { recursive: true });
    await fsp.writeFile(path.join(corruptManifestDir, 'p1', 'data.txt'), 'precious-2', 'utf8');
    await fsp.writeFile(path.join(corruptManifestDir, '.manifest.json'), '{not-valid-json', 'utf8');

    // 3. Directory with symlinked .manifest.json pointing to valid manifest
    const validManifestTarget = path.join(root, 'external-manifest.json');
    await fsp.writeFile(validManifestTarget, JSON.stringify(makeManifest({ state: 'committed', ids: ['p1'] })), 'utf8');
    const symlinkManifestDir = path.join(profileDataRoot, '.ob-del-symlinkmanifest');
    await fsp.mkdir(path.join(symlinkManifestDir, 'p1'), { recursive: true });
    await fsp.writeFile(path.join(symlinkManifestDir, 'p1', 'data.txt'), 'precious-3', 'utf8');
    await fsp.symlink(validManifestTarget, path.join(symlinkManifestDir, '.manifest.json'));

    // 4. Directory with wrong schema / missing kind / invalid target id / duplicate ids / missing committedAt
    const badSchemaDir1 = path.join(profileDataRoot, '.ob-del-badkind');
    await fsp.mkdir(path.join(badSchemaDir1, 'p1'), { recursive: true });
    await fsp.writeFile(path.join(badSchemaDir1, '.manifest.json'), JSON.stringify({
      version: 1, pid: 99999999, startedAt: new Date().toISOString(), committedAt: new Date().toISOString(), state: 'committed', ids: ['p1'],
    }), 'utf8');

    const badSchemaDir2 = path.join(profileDataRoot, '.ob-del-badids');
    await fsp.mkdir(path.join(badSchemaDir2, 'p1'), { recursive: true });
    await fsp.writeFile(path.join(badSchemaDir2, '.manifest.json'), JSON.stringify(makeManifest({
      state: 'committed',
      ids: ['../escape'],
    })), 'utf8');

    const badSchemaDir3 = path.join(profileDataRoot, '.ob-del-nocommittedat');
    await fsp.mkdir(path.join(badSchemaDir3, 'p1'), { recursive: true });
    await fsp.writeFile(path.join(badSchemaDir3, '.manifest.json'), JSON.stringify(makeManifest({
      state: 'committed',
      committedAt: undefined,
      ids: ['p1'],
    })), 'utf8');

    // 5. Valid manifest listing ['del-ok'], PLUS unlisted user files/dirs in the same .ob-del-* folder
    const mixedDir = path.join(profileDataRoot, '.ob-del-mixed-unlisted');
    await fsp.mkdir(path.join(mixedDir, 'del-ok'), { recursive: true });
    await fsp.writeFile(path.join(mixedDir, 'del-ok', 'cache.txt'), 'safe-to-clean', 'utf8');
    await fsp.mkdir(path.join(mixedDir, 'unlisted-profile'), { recursive: true });
    await fsp.writeFile(path.join(mixedDir, 'unlisted-profile', 'keep.txt'), 'must-stay-1', 'utf8');
    await fsp.writeFile(path.join(mixedDir, 'user-notes.txt'), 'must-stay-2', 'utf8');
    await fsp.writeFile(path.join(mixedDir, '.manifest.json'), JSON.stringify(makeManifest({
      state: 'committed',
      ids: ['del-ok'],
    })), 'utf8');

    await engine.recoverDeleteStagingLeftovers();
    await engine.deleteProfiles([], true);

    assert.equal(fs.readFileSync(path.join(noManifestDir, 'important-folder', 'user.txt'), 'utf8'), 'precious-1');
    assert.equal(fs.readFileSync(path.join(corruptManifestDir, 'p1', 'data.txt'), 'utf8'), 'precious-2');
    assert.equal(fs.readFileSync(path.join(symlinkManifestDir, 'p1', 'data.txt'), 'utf8'), 'precious-3');
    assert.equal(fs.existsSync(path.join(badSchemaDir1, 'p1')), true);
    assert.equal(fs.existsSync(path.join(badSchemaDir2, 'p1')), true);
    assert.equal(fs.existsSync(path.join(badSchemaDir3, 'p1')), true);

    // Mixed dir: listed del-ok cleaned, unlisted user files and dir preserved!
    assert.equal(fs.existsSync(path.join(mixedDir, 'del-ok')), false, 'listed committed target cleaned');
    assert.equal(fs.readFileSync(path.join(mixedDir, 'unlisted-profile', 'keep.txt'), 'utf8'), 'must-stay-1');
    assert.equal(fs.readFileSync(path.join(mixedDir, 'user-notes.txt'), 'utf8'), 'must-stay-2');
    assert.equal(fs.existsSync(mixedDir), true, 'staging dir with unknown files must not be removed');
    console.log('  PASS  Unknown .ob-del-* directories, invalid manifests, and unlisted files are strictly preserved');
  } finally {
    try { engine.sqliteStore?.close(); } catch (_) {}
  }
}

async function testFailClosedWhenStoreUnverifiable(root) {
  console.log('\n--- [Test 12] Fail-Closed Preservation When Post-Commit State Is Unverifiable ---');

  // 12a. SQLite closed / query throws -> neither 'staging' nor 'committed' entries may be deleted
  {
    const { engine, profileDataRoot } = await createIsolatedEngine(root, { subdir: 't12a-sqlite-unverifiable' });
    try {
      const bCommit = path.join(profileDataRoot, '.ob-del-fc-commit');
      await fsp.mkdir(path.join(bCommit, 'fc-p1'), { recursive: true });
      await fsp.writeFile(path.join(bCommit, 'fc-p1', 'marker.txt'), 'keep-fc-1', 'utf8');
      await fsp.writeFile(path.join(bCommit, '.manifest.json'), JSON.stringify(makeManifest({
        state: 'committed',
        ids: ['fc-p1'],
      })), 'utf8');

      const bStage = path.join(profileDataRoot, '.ob-del-fc-stage');
      await fsp.mkdir(path.join(bStage, 'fc-p2'), { recursive: true });
      await fsp.writeFile(path.join(bStage, 'fc-p2', 'marker.txt'), 'keep-fc-2', 'utf8');
      await fsp.writeFile(path.join(bStage, '.manifest.json'), JSON.stringify(makeManifest({
        state: 'staging',
        ids: ['fc-p2'],
      })), 'utf8');

      const origGetProfile = engine.sqliteStore.getProfile.bind(engine.sqliteStore);
      engine.sqliteStore.getProfile = () => {
        throw new Error('SQLITE_CORRUPT: unreadable db');
      };
      try {
        await engine.recoverDeleteStagingLeftovers();
      } finally {
        engine.sqliteStore.getProfile = origGetProfile;
      }

      assert.equal(fs.readFileSync(path.join(bCommit, 'fc-p1', 'marker.txt'), 'utf8'), 'keep-fc-1');
      assert.equal(fs.readFileSync(path.join(bStage, 'fc-p2', 'marker.txt'), 'utf8'), 'keep-fc-2');

      // Also test sqliteStore.isOpen === false
      engine.sqliteStore.isOpen = false;
      await engine.recoverDeleteStagingLeftovers();
      assert.equal(fs.readFileSync(path.join(bCommit, 'fc-p1', 'marker.txt'), 'utf8'), 'keep-fc-1');
      assert.equal(fs.readFileSync(path.join(bStage, 'fc-p2', 'marker.txt'), 'utf8'), 'keep-fc-2');

      // Once SQLite is verifiable again, recovery cleans both absent entries
      engine.sqliteStore.isOpen = true;
      await engine.recoverDeleteStagingLeftovers();
      assert.equal(fs.existsSync(bCommit), false);
      assert.equal(fs.existsSync(bStage), false);
    } finally {
      try { engine.sqliteStore?.close(); } catch (_) {}
    }
  }

  // 12b. Uninitialized engine when dbFile exists on disk, OR JSON mode with corrupt/missing stateFile -> fail closed
  {
    const { engine, userData, profileDataRoot, dbPath } = await createIsolatedEngine(root, { subdir: 't12b-uninit-db' });
    await seedProfile(engine, 'fc-p3', { number: 1, withDisk: false });
    engine.sqliteStore.close();

    const bCommit = path.join(profileDataRoot, '.ob-del-uninit');
    await fsp.mkdir(path.join(bCommit, 'fc-p3'), { recursive: true });
    await fsp.writeFile(path.join(bCommit, 'fc-p3', 'marker.txt'), 'keep-fc-3', 'utf8');
    await fsp.writeFile(path.join(bCommit, '.manifest.json'), JSON.stringify(makeManifest({
      state: 'committed',
      ids: ['fc-p3'],
    })), 'utf8');

    // Fresh uninitialized engine (usingSqlite=false, dbFile exists on disk)
    const uninitEngine = new BrowserEngine({ getPath: () => userData }, { profileDataRoot, dbPath, auditLogs: false });
    await uninitEngine.recoverDeleteStagingLeftovers();
    assert.equal(fs.readFileSync(path.join(bCommit, 'fc-p3', 'marker.txt'), 'utf8'), 'keep-fc-3', 'uninitialized engine must fail closed when dbFile exists');

    // JSON mode with corrupt stateFile (no dbFile)
    const jsonUserData = path.join(root, 't12c-corrupt-json');
    const jsonRoot = path.join(jsonUserData, 'browser-profiles-v2');
    await fsp.mkdir(jsonRoot, { recursive: true });
    await fsp.writeFile(path.join(jsonUserData, 'openbrowser-engine.json'), 'corrupted-ciphertext', 'utf8');
    const bJson = path.join(jsonRoot, '.ob-del-corruptstate');
    await fsp.mkdir(path.join(bJson, 'fc-p4'), { recursive: true });
    await fsp.writeFile(path.join(bJson, 'fc-p4', 'marker.txt'), 'keep-fc-4', 'utf8');
    await fsp.writeFile(path.join(bJson, '.manifest.json'), JSON.stringify(makeManifest({
      state: 'committed',
      ids: ['fc-p4'],
    })), 'utf8');

    const corruptJsonEngine = new BrowserEngine({ getPath: () => jsonUserData }, { profileDataRoot: jsonRoot, auditLogs: false });
    await corruptJsonEngine.recoverDeleteStagingLeftovers();
    assert.equal(fs.readFileSync(path.join(bJson, 'fc-p4', 'marker.txt'), 'utf8'), 'keep-fc-4', 'corrupt stateFile must fail closed');
  }

  // 12c. Snapshot rollback protection: committed manifest while DB still holds pre-commit profile & live dir is missing -> fail closed
  {
    const { engine, profileDataRoot } = await createIsolatedEngine(root, { subdir: 't12d-db-rollback' });
    try {
      await seedProfile(engine, 'snap-1', { number: 1, withDisk: false });
      const bSnap = path.join(profileDataRoot, '.ob-del-snap');
      await fsp.mkdir(path.join(bSnap, 'snap-1'), { recursive: true });
      await fsp.writeFile(path.join(bSnap, 'snap-1', 'marker.txt'), 'snap-data', 'utf8');
      await fsp.writeFile(path.join(bSnap, '.manifest.json'), JSON.stringify(makeManifest({
        state: 'committed',
        ids: ['snap-1'],
      })), 'utf8');

      await engine.recoverDeleteStagingLeftovers();
      assert.equal(
        fs.readFileSync(path.join(bSnap, 'snap-1', 'marker.txt'), 'utf8'),
        'snap-data',
        'must fail closed and preserve staged data if DB still holds pre-commit profile without live dir'
      );
    } finally {
      try { engine.sqliteStore?.close(); } catch (_) {}
    }
  }

  console.log('  PASS  Unverifiable store and DB-mismatch conditions consistently fail closed and preserve data');
}

async function testCorruptedRowConflictAndUnverifiableStart(root) {
  console.log('\n--- [Test 13] Corrupted Ciphertext Row, Conflict Start Block, & Unverifiable Start Block ---');

  // 13a. Real corrupted ciphertext row in SQLite (getProfile() returns null!)
  {
    const { engine, userData, profileDataRoot, dbPath } = await createIsolatedEngine(root, { subdir: 't13a-corrupt-row' });
    await seedProfile(engine, 'corrupt-stage-1', { number: 1, withDisk: false });
    await seedProfile(engine, 'corrupt-commit-1', { number: 2, withDisk: false });
    // Overwrite encrypted data column with undecryptable bytes so getProfile() returns null
    engine.sqliteStore.db.prepare('UPDATE profiles SET data = ? WHERE id = ?').run('CORRUPTED_CIPHERTEXT_BLOB', 'corrupt-stage-1');
    engine.sqliteStore.db.prepare('UPDATE profiles SET data = ? WHERE id = ?').run('CORRUPTED_CIPHERTEXT_BLOB', 'corrupt-commit-1');
    assert.equal(engine.sqliteStore.getProfile('corrupt-stage-1'), null, 'getProfile returns null for corrupted ciphertext');
    assert.equal(engine.sqliteStore.getProfile('corrupt-commit-1'), null, 'getProfile returns null for corrupted ciphertext');
    engine.sqliteStore.close();

    const bStage = path.join(profileDataRoot, '.ob-del-corruptstage');
    await fsp.mkdir(path.join(bStage, 'corrupt-stage-1'), { recursive: true });
    await fsp.writeFile(path.join(bStage, 'corrupt-stage-1', 'marker.txt'), 'precious-corrupt-stage', 'utf8');
    await fsp.writeFile(path.join(bStage, '.manifest.json'), JSON.stringify(makeManifest({
      state: 'staging',
      ids: ['corrupt-stage-1'],
    })), 'utf8');

    const bCommit = path.join(profileDataRoot, '.ob-del-corruptcommit');
    await fsp.mkdir(path.join(bCommit, 'corrupt-commit-1'), { recursive: true });
    await fsp.writeFile(path.join(bCommit, 'corrupt-commit-1', 'marker.txt'), 'precious-corrupt-commit', 'utf8');
    await fsp.writeFile(path.join(bCommit, '.manifest.json'), JSON.stringify(makeManifest({
      state: 'committed',
      ids: ['corrupt-commit-1'],
    })), 'utf8');

    // Boot fresh engine via init(): neither corrupted profile loads into engine.profiles,
    // so recovery MUST check raw SQLite id row rather than decoded getProfile()!
    const engine2 = new BrowserEngine({ getPath: () => userData }, { profileDataRoot, dbPath, auditLogs: false });
    try {
      await engine2.init(null);
      assert.equal(engine2.profiles.has('corrupt-stage-1'), false);
      assert.equal(engine2.profiles.has('corrupt-commit-1'), false);

      // staging with existing corrupted row MUST restore directory (never treat as absent & delete!)
      assert.equal(
        fs.readFileSync(path.join(engine2.profileRoot('corrupt-stage-1'), 'marker.txt'), 'utf8'),
        'precious-corrupt-stage',
        'staging recovery must restore directory when raw DB row exists with corrupted ciphertext'
      );
      assert.equal(fs.existsSync(bStage), false);

      // committed with existing corrupted row & no live dir MUST fail closed (preserve & block start!)
      assert.equal(
        fs.readFileSync(path.join(bCommit, 'corrupt-commit-1', 'marker.txt'), 'utf8'),
        'precious-corrupt-commit',
        'committed recovery must fail closed when raw DB row exists with corrupted ciphertext'
      );
      await assert.rejects(
        engine2.start({ id: 'corrupt-commit-1', name: 'Corrupt Commit' }),
        /unrecovered staging data/
      );
      assert.equal(fs.existsSync(engine2.profileRoot('corrupt-commit-1')), false);
      assert.equal(fs.readFileSync(path.join(bCommit, 'corrupt-commit-1', 'marker.txt'), 'utf8'), 'precious-corrupt-commit');
    } finally {
      try { engine2.sqliteStore?.close(); } catch (_) {}
    }
  }

  // 13b. Target conflict during staging recovery MUST add to failedRestoreIds and block start()
  {
    const { engine, profileDataRoot } = await createIsolatedEngine(root, { subdir: 't13b-conflict-start' });
    try {
      const profile = await seedProfile(engine, 'conflict-start', { number: 1, withDisk: true });
      await fsp.writeFile(path.join(engine.profileRoot('conflict-start'), 'marker.txt'), 'live-conflict', 'utf8');

      const bConflict = path.join(profileDataRoot, '.ob-del-conflictstart');
      await fsp.mkdir(path.join(bConflict, 'conflict-start'), { recursive: true });
      await fsp.writeFile(path.join(bConflict, 'conflict-start', 'marker.txt'), 'staged-conflict', 'utf8');
      await fsp.writeFile(path.join(bConflict, '.manifest.json'), JSON.stringify(makeManifest({
        state: 'staging',
        ids: ['conflict-start'],
      })), 'utf8');

      let reachedProxyStage = false;
      engine.prepareProfileProxyForStart = async () => {
        reachedProxyStage = true;
        throw new Error('SHOULD_NOT_REACH');
      };

      await assert.rejects(engine.start(profile), /unrecovered staging data/);
      assert.equal(reachedProxyStage, false, 'start() must abort before launching on target conflict');
      assert.equal(fs.readFileSync(path.join(engine.profileRoot('conflict-start'), 'marker.txt'), 'utf8'), 'live-conflict');
      assert.equal(fs.readFileSync(path.join(bConflict, 'conflict-start', 'marker.txt'), 'utf8'), 'staged-conflict');
    } finally {
      try { engine.sqliteStore?.close(); } catch (_) {}
    }
  }

  // 13c. Unverifiable store during start() MUST fail closed, preserve staged dir, and block empty start
  {
    const { engine, userData, profileDataRoot, dbPath } = await createIsolatedEngine(root, { subdir: 't13c-unverif-start' });
    try {
      const profile = await seedProfile(engine, 'unverif-start', { number: 1, withDisk: false });
      const bStage = path.join(profileDataRoot, '.ob-del-unverifstage');
      await fsp.mkdir(path.join(bStage, 'unverif-start'), { recursive: true });
      await fsp.writeFile(path.join(bStage, 'unverif-start', 'marker.txt'), 'keep-unverif', 'utf8');
      await fsp.writeFile(path.join(bStage, '.manifest.json'), JSON.stringify(makeManifest({
        state: 'staging',
        ids: ['unverif-start'],
      })), 'utf8');

      // Case 1: sqliteStore.isOpen === false
      engine.sqliteStore.isOpen = false;
      let reachedProxy = false;
      engine.prepareProfileProxyForStart = async () => {
        reachedProxy = true;
        throw new Error('SHOULD_NOT_REACH');
      };

      await assert.rejects(engine.start(profile), /unrecovered staging data/);
      assert.equal(reachedProxy, false, 'unverifiable store must block start()');
      assert.equal(fs.existsSync(engine.profileRoot('unverif-start')), false, 'must not create empty dir');
      assert.equal(fs.readFileSync(path.join(bStage, 'unverif-start', 'marker.txt'), 'utf8'), 'keep-unverif');

      // Case 2: fresh uninitialized engine while dbFile exists on disk
      engine.sqliteStore.isOpen = true;
      engine.sqliteStore.close();

      const uninitEngine = new BrowserEngine({ getPath: () => userData }, { profileDataRoot, dbPath, auditLogs: false });
      await assert.rejects(uninitEngine.start(profile), /unrecovered staging data/);
      assert.equal(fs.existsSync(uninitEngine.profileRoot('unverif-start')), false, 'uninitialized engine with dbFile must not create empty dir');
      assert.equal(fs.readFileSync(path.join(bStage, 'unverif-start', 'marker.txt'), 'utf8'), 'keep-unverif');
    } finally {
      try { engine.sqliteStore?.close(); } catch (_) {}
    }
  }

  console.log('  PASS  Corrupted ciphertext row, conflict start block, and unverifiable start block verified');
}

async function testConcurrencyRebuildClockJumpAndLstatError(root) {
  console.log('\n--- [Test 14] Concurrency Mutex, Same-ID Rebuild, Clock-Jump Live PID, & lstat Non-ENOENT ---');

  // 14a. Concurrent deleteProfiles vs start / saveProfile / syncProfiles / setProfileDataRoot
  {
    const { engine, userData, profileDataRoot } = await createIsolatedEngine(root, { subdir: 't14a-mutex' });
    try {
      const p1 = await seedProfile(engine, 'race-1', { number: 1, withDisk: true });
      const p2 = await seedProfile(engine, 'race-2', { number: 2, withDisk: true });
      const altRoot = path.join(userData, 'browser-profiles-alt');

      // Test setProfileDataRoot blocked specifically by active deleteProfiles (running.size === 0, paused in rename)
      await seedProfile(engine, 'race-root', { number: 3, withDisk: true });
      let releaseRenameGate;
      const renameGate = new Promise((resolve) => { releaseRenameGate = resolve; });
      let renameEntered;
      const renameEnteredPromise = new Promise((resolve) => { renameEntered = resolve; });
      const origRenameRace = fsp.rename;
      fsp.rename = async (src, dst) => {
        if (path.resolve(src) === path.resolve(engine.profileRoot('race-root'))) {
          renameEntered();
          await renameGate;
        }
        return origRenameRace(src, dst);
      };
      const delRootPromise = engine.deleteProfiles(['race-root'], true);
      await renameEnteredPromise;
      assert.throws(
        () => engine.setProfileDataRoot(altRoot),
        /Wait for profile deletion/
      );
      releaseRenameGate();
      fsp.rename = origRenameRace;
      await delRootPromise;

      let releaseSlowStop;
      const slowStopGate = new Promise((resolve) => { releaseSlowStop = resolve; });
      engine.running.set('race-1', { pid: 999990 });
      engine.stop = async (id) => {
        if (id === 'race-1') await slowStopGate;
        engine.running.delete(id);
        return { id, running: false };
      };

      const delPromise = engine.deleteProfiles(['race-1'], true);
      await new Promise((r) => setTimeout(r, 15));

      // Phase 1: Concurrent start / saveProfile / syncProfiles launched while deleteProfiles(['race-1']) is mid-flight
      let saveResolvedEarly = false;
      const savePromise = engine.saveProfile({ id: 'race-1', name: 'Saved During Delete' }).then((r) => {
        saveResolvedEarly = true;
        return r;
      });
      let syncResolvedEarly = false;
      const syncPromise = engine.syncProfiles([{ id: 'race-other', name: 'Synced During Delete' }]).then((r) => {
        syncResolvedEarly = true;
        return r;
      });
      const startPromise = engine.start(p1);
      const startHandled = startPromise.then(() => ({ ok: true }), (err) => ({ ok: false, err }));

      await new Promise((r) => setTimeout(r, 20));
      assert.equal(saveResolvedEarly, false, 'saveProfile must wait for active deleteProfiles mutex');
      assert.equal(syncResolvedEarly, false, 'syncProfiles must wait for active deleteProfiles mutex');

      // Let deleteProfiles(['race-1']) proceed
      releaseSlowStop();

      const delRes = await delPromise;
      assert.equal(delRes.deleted, 1);
      const start1Outcome = await startHandled;
      assert.equal(start1Outcome.ok, false);
      assert.equal(start1Outcome.err?.code, 'PROFILE_DELETED');
      assert.equal(fs.existsSync(engine.profileRoot('race-1')), false, 'deleted profile must not leave zombie dir from concurrent start');

      // savePromise & syncPromise ran strictly AFTER delPromise
      const savedAfter = await savePromise;
      assert.equal(savedAfter.success, true);
      assert.equal(engine.profiles.get('race-1')?.name, 'Saved During Delete');
      await syncPromise;
      assert.equal(engine.profiles.get('race-other')?.name, 'Synced During Delete');

      // Phase 2: start() already inside starting -> deleteProfiles(['race-2']) stops it cleanly without deadlock
      let releaseProxyWait;
      const proxyWait = new Promise((resolve) => { releaseProxyWait = resolve; });
      engine.prepareProfileProxyForStart = async (prof) => {
        if (prof.id === 'race-2') await proxyWait;
        return prof;
      };
      const start2Promise = engine.start(p2).then(() => ({ ok: true }), (err) => ({ ok: false, err }));
      await new Promise((r) => setTimeout(r, 15));
      const del2Promise = engine.deleteProfiles(['race-2'], true);
      releaseProxyWait();

      const start2Outcome = await start2Promise;
      assert.equal(start2Outcome.ok, false);
      const del2Res = await del2Promise;
      assert.equal(del2Res.deleted, 1);
      assert.equal(engine.profiles.has('race-2'), false);
      assert.equal(fs.existsSync(engine.profileRoot('race-2')), false);
      void profileDataRoot;
    } finally {
      try { engine.sqliteStore?.close(); } catch (_) {}
    }
  }

  // 14b. Manifest 'committed' write failure AND cleanup failure simultaneously -> same-ID recreation must NEVER restore old dir
  {
    const { engine, userData, profileDataRoot, dbPath } = await createIsolatedEngine(root, { subdir: 't14b-rebuild-guard' });
    try {
      await seedProfile(engine, 'recreate-1', { number: 1, withDisk: true });
      await fsp.writeFile(path.join(engine.profileRoot('recreate-1'), 'marker.txt'), 'OLD_SECRET_COOKIES', 'utf8');

      const origRename = fsp.rename;
      const origRm = fsp.rm;
      // Inject failures on BOTH manifest 'committed' atomic rename (when .manifest.json already exists) AND rm inside .ob-del-*
      fsp.rename = async (src, dst) => {
        if (path.basename(dst) === '.manifest.json' && path.basename(path.dirname(dst)).startsWith('.ob-del-') && fs.existsSync(dst)) {
          const err = new Error('EIO: manifest committed write failed');
          err.code = 'EIO';
          throw err;
        }
        return origRename(src, dst);
      };
      fsp.rm = async (target, opts) => {
        if (path.basename(target) === 'recreate-1' && path.basename(path.dirname(target)).startsWith('.ob-del-')) {
          const err = new Error('EIO: cleanup rm failed');
          err.code = 'EIO';
          throw err;
        }
        return origRm(target, opts);
      };

      let delRes;
      try {
        delRes = await engine.deleteProfiles(['recreate-1'], true);
      } finally {
        fsp.rename = origRename;
        fsp.rm = origRm;
      }
      assert.equal(delRes.deleted, 1);
      assert.equal(delRes.cleanupPending, true);
      assert.equal(engine.sqliteStore.getProfile('recreate-1'), null);

      // Verify on-disk manifest is STILL 'staging' (because committed write failed!)
      const dirs = listDeleteStagingDirs(profileDataRoot);
      assert.equal(dirs.length, 1);
      const batchDir = path.join(profileDataRoot, dirs[0]);
      const diskManifest = JSON.parse(fs.readFileSync(path.join(batchDir, '.manifest.json'), 'utf8'));
      assert.equal(diskManifest.state, 'staging');

      // Same-process: while cleanup still fails, recreating via saveProfile/syncProfiles/start MUST fail closed!
      fsp.rm = async (target, opts) => {
        if (path.basename(target) === 'recreate-1' && path.basename(path.dirname(target)).startsWith('.ob-del-')) {
          const err = new Error('EIO: still locked');
          err.code = 'EIO';
          throw err;
        }
        return origRm(target, opts);
      };
      try {
        await assert.rejects(
          engine.saveProfile({ id: 'recreate-1', name: 'New Recreated' }),
          (err) => err && err.code === 'PROFILE_STAGING_UNRESOLVED'
        );
        await assert.rejects(
          engine.syncProfiles([{ id: 'recreate-1', name: 'New Synced' }]),
          (err) => err && err.code === 'PROFILE_STAGING_UNRESOLVED'
        );
        await assert.rejects(
          engine.start({ id: 'recreate-1', name: 'New Started' }),
          /unrecovered staging data/
        );
        assert.equal(fs.existsSync(engine.profileRoot('recreate-1')), false, 'old dir must NEVER be restored to recreated profile');
      } finally {
        fsp.rm = origRm;
      }

      // Cross-restart test: close DB, simulate restart where cleanup STILL fails on init(), then try recreating
      engine.sqliteStore.close();
      fsp.rm = async (target, opts) => {
        if (path.basename(target) === 'recreate-1' && path.basename(path.dirname(target)).startsWith('.ob-del-')) {
          const err = new Error('EIO: still locked across restart');
          err.code = 'EIO';
          throw err;
        }
        return origRm(target, opts);
      };
      const engine2 = new BrowserEngine({ getPath: () => userData }, { profileDataRoot, dbPath, auditLogs: false });
      try {
        await engine2.init(null);
        await assert.rejects(
          engine2.saveProfile({ id: 'recreate-1', name: 'New After Restart' }),
          (err) => err && err.code === 'PROFILE_STAGING_UNRESOLVED'
        );
        assert.equal(fs.existsSync(engine2.profileRoot('recreate-1')), false, 'must fail closed across restart too');
      } finally {
        fsp.rm = origRm;
      }

      // Once lock clears, saveProfile cleans the stale staging dir and creates the new profile cleanly without old cookies!
      const saveOk = await engine2.saveProfile({ id: 'recreate-1', name: 'Clean Recreated' });
      assert.equal(saveOk.success, true);
      assert.deepEqual(listDeleteStagingDirs(profileDataRoot), []);
      assert.equal(fs.existsSync(engine2.profileRoot('recreate-1')), false, 'recreated profile starts fresh without old disk dir');
      engine2.sqliteStore.close();
    } finally {
      try { engine.sqliteStore?.close(); } catch (_) {}
    }
  }

  // 14c. Wall-clock jump must NOT bypass a live external PID
  {
    const { engine, profileDataRoot } = await createIsolatedEngine(root, { subdir: 't14c-clock-jump' });
    const sleeper = cp.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { stdio: 'ignore' });
    try {
      const liveBatch = path.join(profileDataRoot, '.ob-del-clockjump');
      await fsp.mkdir(path.join(liveBatch, 'clock-p'), { recursive: true });
      await fsp.writeFile(path.join(liveBatch, 'clock-p', 'marker.txt'), 'live-active', 'utf8');
      // Very old wall-clock timestamp (as if wall clock jumped forward after manifest write)
      await fsp.writeFile(path.join(liveBatch, '.manifest.json'), JSON.stringify(makeManifest({
        pid: sleeper.pid,
        startedAt: new Date(1000).toISOString(),
        committedAt: new Date(2000).toISOString(),
        state: 'committed',
        ids: ['clock-p'],
      })), 'utf8');

      await engine.recoverDeleteStagingLeftovers();
      assert.equal(
        fs.readFileSync(path.join(liveBatch, 'clock-p', 'marker.txt'), 'utf8'),
        'live-active',
        'wall-clock jump must never bypass live PID protection'
      );
    } finally {
      sleeper.kill('SIGKILL');
      await new Promise((resolve) => sleeper.on('exit', resolve));
      try { engine.sqliteStore?.close(); } catch (_) {}
    }
  }

  // 14d. committed state + lstat non-ENOENT error on liveRoot must fail closed and NOT delete stagedPath
  {
    const { engine, profileDataRoot } = await createIsolatedEngine(root, { subdir: 't14d-lstat-err' });
    try {
      await seedProfile(engine, 'lstat-1', { number: 1, withDisk: false });
      const bLstat = path.join(profileDataRoot, '.ob-del-lstaterr');
      await fsp.mkdir(path.join(bLstat, 'lstat-1'), { recursive: true });
      await fsp.writeFile(path.join(bLstat, 'lstat-1', 'marker.txt'), 'keep-on-lstat-err', 'utf8');
      await fsp.writeFile(path.join(bLstat, '.manifest.json'), JSON.stringify(makeManifest({
        state: 'committed',
        ids: ['lstat-1'],
      })), 'utf8');

      const origLstat = fsp.lstat;
      fsp.lstat = async (target) => {
        if (path.resolve(target) === path.resolve(engine.profileRoot('lstat-1'))) {
          const err = new Error('EACCES: permission denied');
          err.code = 'EACCES';
          throw err;
        }
        return origLstat(target);
      };
      try {
        await engine.recoverDeleteStagingLeftovers();
      } finally {
        fsp.lstat = origLstat;
      }

      assert.equal(
        fs.readFileSync(path.join(bLstat, 'lstat-1', 'marker.txt'), 'utf8'),
        'keep-on-lstat-err',
        'committed lstat non-ENOENT error must fail closed and preserve stagedPath'
      );
    } finally {
      try { engine.sqliteStore?.close(); } catch (_) {}
    }
  }

  console.log('  PASS  Concurrency mutex, same-ID rebuild guard, clock-jump PID guard, and non-ENOENT lstat guard verified');
}

async function testExternalLocksStopRaceBatchMutexAndCrossProcess(root) {
  console.log('\n--- [Test 15] External Browser Lock/Scan, stop() Starting Cancel, Batch Mutexes, & Cross-Process Lock ---');
  const engineJsPath = path.resolve(__dirname, '../engine.js');
  const { acquireProfileLock, releaseProfileLock } = require('./isolation');

  // 15a. External live .openbrowser-instance.lock AND external OS process with --user-data-dir block deleteProfiles
  {
    const { engine, profileDataRoot } = await createIsolatedEngine(root, { subdir: 't15a-external-lock' });
    try {
      await seedProfile(engine, 'ext-lock-1', { number: 1, withDisk: true });
      await seedProfile(engine, 'ext-proc-1', { number: 2, withDisk: true });

      // Case 1: Live external owner holds .openbrowser-instance.lock
      const lockerChild = cp.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { stdio: 'ignore' });
      const lockFile = path.join(engine.profileRoot('ext-lock-1'), '.openbrowser-instance.lock');
      await fsp.writeFile(lockFile, JSON.stringify({
        profileId: 'ext-lock-1',
        profileRoot: path.resolve(engine.profileRoot('ext-lock-1')),
        pid: lockerChild.pid,
        browserPid: null,
        token: 'ext-token',
        createdAt: new Date().toISOString(),
      }), 'utf8');

      try {
        await assert.rejects(
          engine.deleteProfiles(['ext-lock-1'], true),
          (err) => err && (err.code === 'PROFILE_LOCKED' || /already running/i.test(err.message))
        );
        assert.equal(engine.profiles.has('ext-lock-1'), true);
        assert.ok(engine.sqliteStore.getProfile('ext-lock-1'));
        assert.equal(fs.readFileSync(path.join(engine.profileRoot('ext-lock-1'), 'marker.txt'), 'utf8'), 'data:ext-lock-1');
      } finally {
        if (lockerChild.exitCode === null && lockerChild.signalCode === null) {
          lockerChild.kill('SIGKILL');
          await new Promise((r) => lockerChild.once('exit', r));
        }
      }

      // Case 2: External rogue browser process running with --user-data-dir=<profileRoot> even WITHOUT lockfile
      const extDir = path.resolve(engine.profileRoot('ext-proc-1'));
      const rogueProc = cp.spawn(
        process.execPath,
        ['-e', 'setInterval(() => {}, 1000);', '--', `--user-data-dir=${extDir}`],
        { stdio: 'ignore' }
      );
      try {
        await new Promise((r) => setTimeout(r, 80));
        assert.equal(rogueProc.exitCode, null, 'rogue process fixture must still be alive');
        await assert.rejects(
          engine.deleteProfiles(['ext-proc-1'], true),
          (err) => err && err.code === 'PROFILE_LOCKED'
        );
        assert.equal(engine.profiles.has('ext-proc-1'), true);
        assert.ok(engine.sqliteStore.getProfile('ext-proc-1'));
        assert.equal(fs.readFileSync(path.join(extDir, 'marker.txt'), 'utf8'), 'data:ext-proc-1');
      } finally {
        if (rogueProc.exitCode === null && rogueProc.signalCode === null) {
          rogueProc.kill('SIGKILL');
          await new Promise((r) => rogueProc.once('exit', r));
        }
      }

      const isolation = require('./isolation');
      const originalScan = isolation.scanProcessesUsingProfileAsync;
      isolation.scanProcessesUsingProfileAsync = async () => ({ known: false, pids: [] });
      try {
        await assert.rejects(engine.deleteProfiles(['ext-proc-1'], true), (err) => err.code === 'PROFILE_PROCESS_SCAN_FAILED');
        assert.equal(fs.readFileSync(path.join(extDir, 'marker.txt'), 'utf8'), 'data:ext-proc-1');
        assert.ok(engine.sqliteStore.getProfile('ext-proc-1'));
      } finally {
        isolation.scanProcessesUsingProfileAsync = originalScan;
      }

      // Once external process exits and stale lock is dead, deleteProfiles succeeds cleanly
      const cleanRes = await engine.deleteProfiles(['ext-proc-1'], true);
      assert.equal(cleanRes.deleted, 1);
      assert.equal(fs.existsSync(extDir), false);
      void profileDataRoot;
    } finally {
      try { engine.sqliteStore?.close(); } catch (_) {}
    }
  }

  // 15b. stop(id) hitting existing stopping MUST still cancel waiting starting
  {
    const { engine } = await createIsolatedEngine(root, { subdir: 't15b-stop-race' });
    try {
      const p = await seedProfile(engine, 'stop-race-1', { number: 1, withDisk: false });
      let releaseFirstStop;
      const firstStopGate = new Promise((resolve) => { releaseFirstStop = resolve; });
      const firstStopPromise = (async () => {
        await firstStopGate;
        engine.running.delete('stop-race-1');
        return { id: 'stop-race-1', running: false };
      })();
      engine.running.set('stop-race-1', { pid: 123 });
      engine.stopping.set('stop-race-1', firstStopPromise);

      let reachedAfterPendingStop = false;
      engine._start = async (raw, generation) => {
        reachedAfterPendingStop = true;
        engine.assertStartGenerationActive(raw.id, generation);
        engine.running.set(raw.id, { profile: raw, lifecycleGeneration: generation, cleanedUp: false, stopping: false });
        return engine.publicRunning(raw.id);
      };

      const startTask = engine.start(p).then(() => ({ ok: true }), (err) => ({ ok: false, err }));
      await new Promise((r) => setTimeout(r, 15));
      assert.equal(engine.stopping.has('stop-race-1'), true);
      assert.equal(engine.starting.has('stop-race-1'), true);

      const secondStopTask = engine.stop('stop-race-1');
      releaseFirstStop();
      engine.stopping.delete('stop-race-1');

      const startOutcome = await startTask;
      const stopOutcome = await secondStopTask;
      assert.equal(reachedAfterPendingStop, false, 'cancelled waiting starting must abort before entering _start');
      assert.equal(startOutcome.ok, false, 'waiting starting must be cancelled when stop hits existing stopping');
      assert.equal(startOutcome.err?.code, 'BROWSER_START_CANCELLED');
      assert.equal(stopOutcome.running, false);
      assert.equal(engine.running.has('stop-race-1'), false);
    } finally {
      try { engine.sqliteStore?.close(); } catch (_) {}
    }
  }

  // 15c. All batch methods (batchPatch, clone, renumber, trash, restore, emptyTrash) serialized cleanly with deleteProfiles
  {
    const { engine } = await createIsolatedEngine(root, { subdir: 't15c-batch-mutex' });
    try {
      await seedProfile(engine, 'bm-1', { number: 1, withDisk: true });
      await seedProfile(engine, 'bm-2', { number: 2, withDisk: true });
      await seedProfile(engine, 'bm-3', { number: 3, withDisk: true });

      const [patchRes, cloneRes1, cloneRes2, trashRes, restoreRes, renumRes] = await Promise.all([
        engine.batchPatchProfiles({ ids: ['bm-1', 'bm-2'], groupId: 'grp-mutex' }),
        engine.cloneProfiles({ ids: ['bm-1'] }),
        engine.cloneProfiles({ ids: ['bm-2'] }),
        engine.trashProfiles(['bm-3']),
        engine.restoreProfiles(['bm-3']),
        engine.renumberProfiles(),
      ]);

      assert.equal(patchRes.success, true);
      assert.equal(cloneRes1.count, 1);
      assert.equal(cloneRes2.count, 1);
      assert.notEqual(cloneRes1.profiles[0].number, cloneRes2.profiles[0].number, 'concurrent clones must allocate distinct numbers');
      assert.equal(trashRes.trashed, 1);
      assert.equal(restoreRes.restored, 1);
      assert.equal(renumRes.success, true);

      await engine.trashProfiles(['bm-3']);
      const emptyRes = await engine.emptyTrash(true);
      assert.equal(emptyRes.deleted, 1);
      assert.equal(engine.profiles.has('bm-3'), false);
      assert.equal(fs.existsSync(engine.profileRoot('bm-3')), false);
    } finally {
      try { engine.sqliteStore?.close(); } catch (_) {}
    }
  }

  // 15d. Cross-process lock (.openbrowser-delete.lock) serializes concurrent OS processes & reclaims dead PID lock
  {
    const { engine, userData, profileDataRoot, dbPath } = await createIsolatedEngine(root, { subdir: 't15d-cross-proc-lock' });
    await seedProfile(engine, 'cp-1', { number: 1, withDisk: true });
    await seedProfile(engine, 'cp-2', { number: 2, withDisk: true });
    engine.sqliteStore.close();

    // Child A holds cross-process lock inside deleteProfiles(['cp-1']) until told to proceed
    const childACode = `
      const fsp = require('node:fs/promises');
      const path = require('node:path');
      const { BrowserEngine } = require(${JSON.stringify(engineJsPath)});
      (async () => {
        const engine = new BrowserEngine(
          { getPath: () => ${JSON.stringify(userData)} },
          { profileDataRoot: ${JSON.stringify(profileDataRoot)}, dbPath: ${JSON.stringify(dbPath)}, auditLogs: false }
        );
        await engine.init(null);
        const origRename = fsp.rename;
        fsp.rename = async (src, dst) => {
          if (path.resolve(src) === path.resolve(engine.profileRoot('cp-1'))) {
            process.stdout.write('LOCK_HELD_IN_A\\n');
            await new Promise((r) => setTimeout(r, 350));
          }
          return origRename(src, dst);
        };
        await engine.deleteProfiles(['cp-1'], true);
        process.stdout.write('CHILD_A_DONE\\n');
      })();
    `;

    const childBCode = `
      const { BrowserEngine } = require(${JSON.stringify(engineJsPath)});
      (async () => {
        const engine = new BrowserEngine(
          { getPath: () => ${JSON.stringify(userData)} },
          { profileDataRoot: ${JSON.stringify(profileDataRoot)}, dbPath: ${JSON.stringify(dbPath)}, auditLogs: false }
        );
        await engine.init(null);
        await engine.deleteProfiles(['cp-2'], true);
        process.stdout.write('CHILD_B_DONE\\n');
      })();
    `;

    const childA = cp.spawn(process.execPath, ['-e', childACode], { stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((resolve, reject) => {
      let stderr = '';
      childA.stderr.on('data', (d) => { stderr += d.toString(); });
      childA.stdout.on('data', (d) => {
        if (d.toString().includes('LOCK_HELD_IN_A')) resolve();
      });
      childA.on('exit', (code) => reject(new Error(`ChildA exited early (${code}): ${stderr}`)));
    });

    const eventsOrder = [];
    const childB = cp.spawn(process.execPath, ['-e', childBCode], { stdio: ['ignore', 'pipe', 'pipe'] });
    await Promise.all([
      new Promise((resolve, reject) => {
        let out = '';
        let err = '';
        childA.stderr.on('data', (d) => { err += d.toString(); });
        childA.stdout.on('data', (d) => {
          out += d.toString();
          if (out.includes('CHILD_A_DONE')) eventsOrder.push('A');
        });
        childA.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ChildA failed (${code}): ${err}`))));
      }),
      new Promise((resolve, reject) => {
        let out = '';
        let err = '';
        childB.stderr.on('data', (d) => { err += d.toString(); });
        childB.stdout.on('data', (d) => {
          out += d.toString();
          if (out.includes('CHILD_B_DONE')) eventsOrder.push('B');
        });
        childB.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ChildB failed (${code}): ${err}`))));
      }),
    ]);

    assert.deepEqual(eventsOrder, ['A', 'B'], 'Child B must wait for Child A cross-process lock before deleting');
    assert.equal(fs.existsSync(path.join(profileDataRoot, '.openbrowser-delete.lock')), false);
    assert.deepEqual(listDeleteStagingDirs(profileDataRoot), []);

    // Conservative fail-closed guard: dead-PID / corrupt non-empty .openbrowser-delete.lock MUST NOT be rm'd (avoid TOCTOU) — refuse & preserve!
    const { engine: checkEngine } = await createIsolatedEngine(root, { subdir: 't15d-cross-proc-lock' });
    try {
      const deadLockPath = path.join(profileDataRoot, '.openbrowser-delete.lock');
      await fsp.writeFile(deadLockPath, JSON.stringify({
        pid: 99999999,
        token: 'dead-token',
        dataRoot: path.resolve(profileDataRoot),
        createdAt: new Date().toISOString(),
      }), 'utf8');
      await assert.rejects(
        checkEngine.deleteProfiles([], true),
        (err) => err && err.code === 'CROSS_PROCESS_LOCK_UNRECOVERABLE'
      );
      assert.equal(fs.existsSync(deadLockPath), true, 'dead legacy lock must be preserved, never TOCTOU-rmed');

      // Truncated non-empty corrupt lock must immediately fail closed and preserve (not hang until timeout)
      await fsp.writeFile(deadLockPath, '{"pid":123', 'utf8');
      const t0 = Date.now();
      await assert.rejects(
        checkEngine.deleteProfiles([], true),
        (err) => err && err.code === 'CROSS_PROCESS_LOCK_UNRECOVERABLE'
      );
      assert.ok(Date.now() - t0 < 2000, 'corrupt non-empty lock must fail closed immediately without spinning');
      assert.equal(fs.readFileSync(deadLockPath, 'utf8'), '{"pid":123', 'corrupt lock must remain preserved');
      await fsp.rm(deadLockPath, { force: true });
    } finally {
      try { checkEngine.sqliteStore?.close(); } catch (_) {}
    }
  }

  // 15e. True OS child-process restart after BOTH manifest 'committed' write fail AND rm fail -> durable ob_committed_delete_batches prevents same-ID restore
  {
    const { engine, userData, profileDataRoot, dbPath } = await createIsolatedEngine(root, { subdir: 't15e-true-restart-rebuild' });
    await seedProfile(engine, 'xp-1', { number: 1, withDisk: true });
    await fsp.writeFile(path.join(engine.profileRoot('xp-1'), 'marker.txt'), 'OLD_XP1_SECRET', 'utf8');
    engine.sqliteStore.close();

    const child1Code = `
      const fs = require('node:fs');
      const fsp = require('node:fs/promises');
      const path = require('node:path');
      const { BrowserEngine } = require(${JSON.stringify(engineJsPath)});
      (async () => {
        const engine = new BrowserEngine(
          { getPath: () => ${JSON.stringify(userData)} },
          { profileDataRoot: ${JSON.stringify(profileDataRoot)}, dbPath: ${JSON.stringify(dbPath)}, auditLogs: false }
        );
        await engine.init(null);
        const origRename = fsp.rename;
        const origRm = fsp.rm;
        fsp.rename = async (src, dst) => {
          if (path.basename(dst) === '.manifest.json' && path.basename(path.dirname(dst)).startsWith('.ob-del-') && fs.existsSync(dst)) {
            const err = new Error('EIO: manifest committed write fail');
            err.code = 'EIO';
            throw err;
          }
          return origRename(src, dst);
        };
        fsp.rm = async (target, opts) => {
          if (path.basename(target) === 'xp-1' && path.basename(path.dirname(target)).startsWith('.ob-del-')) {
            const err = new Error('EIO: rm fail');
            err.code = 'EIO';
            throw err;
          }
          return origRm(target, opts);
        };
        const res = await engine.deleteProfiles(['xp-1'], true);
        if (!res.cleanupPending) throw new Error('Expected cleanupPending');
        engine.sqliteStore.close();
      })();
    `;

    await new Promise((resolve, reject) => {
      const child = cp.spawn(process.execPath, ['-e', child1Code], { stdio: ['ignore', 'pipe', 'pipe'] });
      let err = '';
      child.stderr.on('data', (d) => { err += d.toString(); });
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`Child1 failed (${code}): ${err}`))));
    });

    // Now in a brand-new OS child process (empty RAM!), even if xp-1 is manually inserted directly into SQLite
    // while cleanup still fails, durable ob_committed_delete_batches MUST prevent restoring OLD_XP1_SECRET!
    const child2Code = `
      const assert = require('node:assert/strict');
      const fs = require('node:fs');
      const fsp = require('node:fs/promises');
      const path = require('node:path');
      const { BrowserEngine } = require(${JSON.stringify(engineJsPath)});
      (async () => {
        const engine = new BrowserEngine(
          { getPath: () => ${JSON.stringify(userData)} },
          { profileDataRoot: ${JSON.stringify(profileDataRoot)}, dbPath: ${JSON.stringify(dbPath)}, auditLogs: false }
        );
        const origRm = fsp.rm;
        fsp.rm = async (target, opts) => {
          if (path.basename(target) === 'xp-1' && path.basename(path.dirname(target)).startsWith('.ob-del-')) {
            const err = new Error('EIO: still locked in child2');
            err.code = 'EIO';
            throw err;
          }
          return origRm(target, opts);
        };
        await engine.init(null);
        // Simulate direct out-of-band DB re-insertion of xp-1 (without live dir) while manifest still says 'staging'
        engine.sqliteStore.saveProfiles([{ id: 'xp-1', number: 1, name: 'Recreated Direct' }]);
        await engine.recoverDeleteStagingLeftovers();
        assert.equal(fs.existsSync(engine.profileRoot('xp-1')), false, 'must NEVER restore old deleted dir onto recreated xp-1 across OS restart');
        // Once lock clears, cleanup removes old dir & clears durable meta
        fsp.rm = origRm;
        // Create live dir for recreated xp-1, then verify cleanup deletes stale dir cleanly without touching live dir
        await fsp.mkdir(engine.profileRoot('xp-1'), { recursive: true });
        await fsp.writeFile(path.join(engine.profileRoot('xp-1'), 'marker.txt'), 'FRESH_XP1', 'utf8');
        await engine.recoverDeleteStagingLeftovers();
        assert.equal(fs.readFileSync(path.join(engine.profileRoot('xp-1'), 'marker.txt'), 'utf8'), 'FRESH_XP1');
        const meta = engine.sqliteStore.getAllMeta();
        assert.deepEqual(meta.ob_committed_delete_batches || {}, {});
        engine.sqliteStore.close();
      })();
    `;

    await new Promise((resolve, reject) => {
      const child = cp.spawn(process.execPath, ['-e', child2Code], { stdio: ['ignore', 'pipe', 'pipe'] });
      let err = '';
      child.stderr.on('data', (d) => { err += d.toString(); });
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`Child2 failed (${code}): ${err}`))));
    });
  }

  void acquireProfileLock;
  void releaseProfileLock;
  console.log('  PASS  External lock/process block, stop() starting cancel, batch mutexes, cross-process lock, and cross-restart rebuild guard verified');
}

async function testEmptyTrashRaceCrossProcessSaveAndStagedLockRelease(root) {
  console.log('\n--- [Test 16] emptyTrash vs restore Race, Cross-Process save/delete Race, & Staged Lock Release ---');
  const engineJsPath = path.resolve(__dirname, '../engine.js');

  // 16a. emptyTrash snapshot + concurrent restoreProfiles -> restored profile MUST NOT be deleted
  {
    const { engine } = await createIsolatedEngine(root, { subdir: 't16a-emptytrash-restore' });
    try {
      await seedProfile(engine, 'et-1', { number: 1, withDisk: true });
      await seedProfile(engine, 'et-2', { number: 2, withDisk: true });
      await seedProfile(engine, 'et-3', { number: 3, withDisk: true });
      await engine.trashProfiles(['et-1', 'et-2']);

      const origPurge = engine.purgeProfiles.bind(engine);
      engine.purgeProfiles = async (ids, deleteData, opts) => {
        // Simulate restoreProfiles(['et-2']) winning between emptyTrash's snapshot and deleteProfiles lock!
        await engine.restoreProfiles(['et-2']);
        return origPurge(ids, deleteData, opts);
      };

      const emptyRes = await engine.emptyTrash(true);
      assert.equal(emptyRes.deleted, 1, 'only still-trashed et-1 should be deleted');
      assert.deepEqual(emptyRes.ids, ['et-1']);
      assert.equal(engine.profiles.has('et-1'), false);
      assert.equal(fs.existsSync(engine.profileRoot('et-1')), false);

      assert.equal(engine.profiles.has('et-2'), true, 'restored et-2 must NOT be deleted by concurrent emptyTrash');
      assert.equal(engine.profiles.get('et-2').trashed, false);
      assert.equal(engine.sqliteStore.getProfile('et-2').trashed, false);
      assert.equal(fs.readFileSync(path.join(engine.profileRoot('et-2'), 'marker.txt'), 'utf8'), 'data:et-2');

      assert.equal(engine.profiles.has('et-3'), true);
    } finally {
      try { engine.sqliteStore?.close(); } catch (_) {}
    }
  }

  // 16b. Cross-process saveProfile/syncProfiles waits on .openbrowser-delete.lock.db held by Child A deleteProfiles
  {
    const { engine, userData, profileDataRoot, dbPath } = await createIsolatedEngine(root, { subdir: 't16b-cross-save' });
    await seedProfile(engine, 'xsave-1', { number: 1, withDisk: true });
    engine.sqliteStore.close();

    const childACode = `
      const fsp = require('node:fs/promises');
      const path = require('node:path');
      const { BrowserEngine } = require(${JSON.stringify(engineJsPath)});
      (async () => {
        const engine = new BrowserEngine(
          { getPath: () => ${JSON.stringify(userData)} },
          { profileDataRoot: ${JSON.stringify(profileDataRoot)}, dbPath: ${JSON.stringify(dbPath)}, auditLogs: false }
        );
        await engine.init(null);
        const origRename = fsp.rename;
        fsp.rename = async (src, dst) => {
          if (path.resolve(src) === path.resolve(engine.profileRoot('xsave-1'))) {
            process.stdout.write('DEL_LOCKED\\n');
            await new Promise((r) => setTimeout(r, 350));
          }
          return origRename(src, dst);
        };
        await engine.deleteProfiles(['xsave-1'], true);
        engine.sqliteStore.close();
      })();
    `;

    const childBCode = `
      const { BrowserEngine } = require(${JSON.stringify(engineJsPath)});
      (async () => {
        const engine = new BrowserEngine(
          { getPath: () => ${JSON.stringify(userData)} },
          { profileDataRoot: ${JSON.stringify(profileDataRoot)}, dbPath: ${JSON.stringify(dbPath)}, auditLogs: false }
        );
        await engine.init(null);
        await engine.saveProfile({ id: 'xsave-1', name: 'Recreated After Cross Delete' });
        engine.sqliteStore.close();
      })();
    `;

    const childA = cp.spawn(process.execPath, ['-e', childACode], { stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((resolve, reject) => {
      let err = '';
      childA.stderr.on('data', (d) => { err += d.toString(); });
      childA.stdout.on('data', (d) => {
        if (d.toString().includes('DEL_LOCKED')) resolve();
      });
      childA.on('exit', (code) => reject(new Error(`ChildA exited early (${code}): ${err}`)));
    });

    const childB = cp.spawn(process.execPath, ['-e', childBCode], { stdio: ['ignore', 'pipe', 'pipe'] });
    await Promise.all([
      new Promise((resolve, reject) => {
        let err = '';
        childA.stderr.on('data', (d) => { err += d.toString(); });
        childA.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ChildA failed (${code}): ${err}`))));
      }),
      new Promise((resolve, reject) => {
        let err = '';
        childB.stderr.on('data', (d) => { err += d.toString(); });
        childB.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ChildB failed (${code}): ${err}`))));
      }),
    ]);

    const { engine: verifyEngine } = await createIsolatedEngine(root, { subdir: 't16b-cross-save' });
    try {
      const recreated = verifyEngine.sqliteStore.getProfile('xsave-1');
      assert.ok(recreated, 'saveProfile in Child B must wait for Child A delete lock and not be deleted by Child A');
      assert.equal(recreated.name, 'Recreated After Cross Delete');
      assert.equal(fs.existsSync(verifyEngine.profileRoot('xsave-1')), false, 'old disk dir deleted cleanly by Child A');
    } finally {
      try { verifyEngine.sqliteStore?.close(); } catch (_) {}
    }
  }

  // 16c. When staged directory stays in stagingDir (DB fail + rollback fail), .openbrowser-instance.lock inside stagedPath MUST be released!
  {
    const { engine, profileDataRoot } = await createIsolatedEngine(root, { subdir: 't16c-staged-lock-release' });
    try {
      await seedProfile(engine, 'stlock-1', { number: 1, withDisk: true });

      const origDelete = engine.sqliteStore.deleteProfiles.bind(engine.sqliteStore);
      const origRename = fsp.rename;
      engine.sqliteStore.deleteProfiles = () => {
        throw new Error('synthetic db fail');
      };
      fsp.rename = async (src, dst) => {
        if (path.basename(path.dirname(src)).startsWith('.ob-del-') && path.basename(src) === 'stlock-1') {
          const err = new Error('EIO: rollback rename fail');
          err.code = 'EIO';
          throw err;
        }
        return origRename(src, dst);
      };
      try {
        await assert.rejects(engine.deleteProfiles(['stlock-1'], true), /synthetic db fail/);
      } finally {
        engine.sqliteStore.deleteProfiles = origDelete;
        fsp.rename = origRename;
      }

      const stagingDirs = listDeleteStagingDirs(profileDataRoot);
      assert.equal(stagingDirs.length, 1);
      const stagedProfileDir = path.join(profileDataRoot, stagingDirs[0], 'stlock-1');
      assert.equal(
        fs.existsSync(path.join(stagedProfileDir, '.openbrowser-instance.lock')),
        false,
        '.openbrowser-instance.lock inside stagedPath must be released safely so profile is not left locked'
      );

      // Next recovery restores stlock-1 cleanly
      await engine.recoverDeleteStagingLeftovers();
      assert.equal(fs.readFileSync(path.join(engine.profileRoot('stlock-1'), 'marker.txt'), 'utf8'), 'data:stlock-1');
    } finally {
      try { engine.sqliteStore?.close(); } catch (_) {}
    }
  }

  console.log('  PASS  emptyTrash restore race, cross-process save/delete serialization, and staged lock release verified');
}

async function testDualProcessStaleCacheStartPersistAndNoRootLock(root) {
  console.log('\n--- [Test 17] Dual-Process Stale Cache (SQLite & JSON), _start() No-Resurrection, No-Root Lock, & onlyIfTrashed No-Stop ---');
  const engineJsPath = path.resolve(__dirname, '../engine.js');
  const sqliteModulePath = path.resolve(__dirname, '../automation/profile-store-sqlite.js');

  // 17a. Dual OS processes in SQLite mode: stale mem in Process A must NEVER delete disk dir retained by Process B (deleteData=false)
  {
    const { engine: engineA, userData, profileDataRoot, dbPath } = await createIsolatedEngine(root, { subdir: 't17a-sqlite-stale' });
    try {
      await seedProfile(engineA, 'stale-sq-1', { number: 1, withDisk: true });
      await fsp.writeFile(path.join(engineA.profileRoot('stale-sq-1'), 'marker.txt'), 'KEEP_SQ1_DISK', 'utf8');
      await engineA.trashProfiles(['stale-sq-1']);
      assert.equal(engineA.profiles.get('stale-sq-1')?.trashed, true);

      // Child B (separate OS process) deletes stale-sq-1 with deleteData = false (keeps disk directory!)
      const childBCode = `
        const { BrowserEngine } = require(${JSON.stringify(engineJsPath)});
        (async () => {
          const engine = new BrowserEngine(
            { getPath: () => ${JSON.stringify(userData)} },
            { profileDataRoot: ${JSON.stringify(profileDataRoot)}, dbPath: ${JSON.stringify(dbPath)}, auditLogs: false }
          );
          await engine.init(null);
          const res = await engine.deleteProfiles(['stale-sq-1'], false);
          if (res.deleted !== 1) throw new Error('Expected Child B to delete 1');
          engine.sqliteStore.close();
        })();
      `;
      await new Promise((resolve, reject) => {
        const child = cp.spawn(process.execPath, ['-e', childBCode], { stdio: ['ignore', 'pipe', 'pipe'] });
        let err = '';
        child.stderr.on('data', (d) => { err += d.toString(); });
        child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ChildB failed (${code}): ${err}`))));
      });

      // Confirm Child B deleted DB row while preserving disk dir
      assert.equal(engineA.sqliteStore.getProfile('stale-sq-1'), null);
      assert.equal(fs.readFileSync(path.join(engineA.profileRoot('stale-sq-1'), 'marker.txt'), 'utf8'), 'KEEP_SQ1_DISK');
      // Process A STILL holds stale in-memory entry!
      assert.equal(engineA.profiles.get('stale-sq-1')?.trashed, true);

      // Process A runs emptyTrash(true) and deleteProfiles(['stale-sq-1'], true) -> MUST NOT touch retained disk dir!
      const emptyRes = await engineA.emptyTrash(true);
      assert.equal(emptyRes.deleted, 0);
      assert.equal(fs.readFileSync(path.join(engineA.profileRoot('stale-sq-1'), 'marker.txt'), 'utf8'), 'KEEP_SQ1_DISK');

      engineA.profiles.set('stale-sq-1', engineA.sanitizeProfile({ id: 'stale-sq-1', name: 'Stale Sq 1', trashed: true }));
      const delRes = await engineA.deleteProfiles(['stale-sq-1'], true);
      assert.equal(delRes.deleted, 0);
      assert.equal(engineA.profiles.has('stale-sq-1'), false, 'stale mem entry evicted');
      assert.equal(
        fs.readFileSync(path.join(engineA.profileRoot('stale-sq-1'), 'marker.txt'), 'utf8'),
        'KEEP_SQ1_DISK',
        'retained disk dir must NOT be deleted via stale mem fallback'
      );
    } finally {
      try { engineA.sqliteStore?.close(); } catch (_) {}
    }
  }

  // 17b. Dual OS processes in JSON mode: Process A reloads openbrowser-engine.json inside lock instead of acting on stale mem
  {
    const { ProfileStoreSqlite } = require('../automation/profile-store-sqlite');
    const origSupported = ProfileStoreSqlite.isSupported;
    ProfileStoreSqlite.isSupported = () => false;
    try {
      const userData = path.join(root, 't17b-json-stale');
      const profileDataRoot = path.join(userData, 'browser-profiles-v2');
      await fsp.mkdir(userData, { recursive: true });

      const engineA = new BrowserEngine({ getPath: () => userData }, { profileDataRoot, auditLogs: false });
      await engineA.init(null);
      assert.equal(engineA.usingSqlite, false);

      await engineA.syncProfiles([
        { id: 'json-keep-1', number: 1, name: 'Keep 1', trashed: true },
        { id: 'json-rest-1', number: 2, name: 'Restore 1', trashed: true },
      ]);
      await fsp.mkdir(engineA.profileRoot('json-keep-1'), { recursive: true });
      await fsp.writeFile(path.join(engineA.profileRoot('json-keep-1'), 'marker.txt'), 'KEEP_JSON1', 'utf8');
      await fsp.mkdir(engineA.profileRoot('json-rest-1'), { recursive: true });
      await fsp.writeFile(path.join(engineA.profileRoot('json-rest-1'), 'marker.txt'), 'KEEP_JSON_REST', 'utf8');

      // Child B (separate OS JSON process) deletes json-keep-1 (deleteData=false) & restores json-rest-1
      const childJsonCode = `
        const { ProfileStoreSqlite } = require(${JSON.stringify(sqliteModulePath)});
        ProfileStoreSqlite.isSupported = () => false;
        const { BrowserEngine } = require(${JSON.stringify(engineJsPath)});
        (async () => {
          const engine = new BrowserEngine(
            { getPath: () => ${JSON.stringify(userData)} },
            { profileDataRoot: ${JSON.stringify(profileDataRoot)}, auditLogs: false }
          );
          await engine.init(null);
          await engine.deleteProfiles(['json-keep-1'], false);
          await engine.restoreProfiles(['json-rest-1']);
        })();
      `;
      await new Promise((resolve, reject) => {
        const child = cp.spawn(process.execPath, ['-e', childJsonCode], { stdio: ['ignore', 'pipe', 'pipe'] });
        let err = '';
        child.stderr.on('data', (d) => { err += d.toString(); });
        child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ChildJSON failed (${code}): ${err}`))));
      });

      // Process A STILL holds stale trashed=true for both!
      assert.equal(engineA.profiles.get('json-keep-1')?.trashed, true);
      assert.equal(engineA.profiles.get('json-rest-1')?.trashed, true);

      // Process A runs emptyTrash(true) -> MUST reload openbrowser-engine.json under lock and delete NOTHING!
      const emptyRes = await engineA.emptyTrash(true);
      assert.equal(emptyRes.deleted, 0);
      assert.equal(engineA.profiles.has('json-keep-1'), false);
      assert.equal(engineA.profiles.get('json-rest-1')?.trashed, false);
      assert.equal(fs.readFileSync(path.join(engineA.profileRoot('json-keep-1'), 'marker.txt'), 'utf8'), 'KEEP_JSON1');
      assert.equal(fs.readFileSync(path.join(engineA.profileRoot('json-rest-1'), 'marker.txt'), 'utf8'), 'KEEP_JSON_REST');
    } finally {
      ProfileStoreSqlite.isSupported = origSupported;
    }
  }

  // 17c. _start() persist MUST NOT resurrect profiles deleted by another OS process (SQLite + JSON)
  {
    const { engine: engineA, userData, profileDataRoot, dbPath } = await createIsolatedEngine(root, { subdir: 't17c-start-noresurrect' });
    try {
      const pAlive = await seedProfile(engineA, 'p-alive', { number: 1, withDisk: true });
      await seedProfile(engineA, 'p-del', { number: 2, withDisk: true });

      let enteredProxy;
      const proxyEntered = new Promise((resolve) => { enteredProxy = resolve; });
      let releaseProxy;
      const proxyGate = new Promise((resolve) => { releaseProxy = resolve; });

      engineA.prepareProfileProxyForStart = async (prof) => {
        enteredProxy();
        await proxyGate;
        return prof;
      };
      engineA.chooseBrowser = () => {
        throw new Error('STOP_AT_CHOOSE_BROWSER');
      };

      const startTask = engineA.start(pAlive).then(() => ({ ok: true }), (err) => ({ ok: false, err }));
      await proxyEntered;

      // While Process A is mid-start on p-alive, Child B deletes p-del in SQLite & disk
      const childDelCode = `
        const { BrowserEngine } = require(${JSON.stringify(engineJsPath)});
        (async () => {
          const engine = new BrowserEngine(
            { getPath: () => ${JSON.stringify(userData)} },
            { profileDataRoot: ${JSON.stringify(profileDataRoot)}, dbPath: ${JSON.stringify(dbPath)}, auditLogs: false }
          );
          await engine.init(null);
          await engine.deleteProfiles(['p-del'], true);
          engine.sqliteStore.close();
        })();
      `;
      await new Promise((resolve, reject) => {
        const child = cp.spawn(process.execPath, ['-e', childDelCode], { stdio: ['ignore', 'pipe', 'pipe'] });
        let err = '';
        child.stderr.on('data', (d) => { err += d.toString(); });
        child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ChildDel failed (${code}): ${err}`))));
      });

      releaseProxy();
      const startRes = await startTask;
      assert.equal(startRes.ok, false);
      assert.match(startRes.err.message, /STOP_AT_CHOOSE_BROWSER/);
      assert.equal(engineA.sqliteStore.getProfile('p-del'), null, '_start persist must NOT resurrect p-del deleted by Child B');
      assert.equal(fs.existsSync(engineA.profileRoot('p-del')), false);
    } finally {
      try { engineA.sqliteStore?.close(); } catch (_) {}
    }
  }

  // 17d. Cross-process lock works even when profileDataRoot does NOT exist yet on disk (createDir: true)
  {
    const userData = path.join(root, 't17d-noroot-lock');
    const profileDataRoot = path.join(userData, 'browser-profiles-v2');
    const dbPath = path.join(userData, 'openbrowser-data.db');
    await fsp.mkdir(userData, { recursive: true });
    // Note: intentionally do NOT create profileDataRoot yet!
    const seedEngine = new BrowserEngine({ getPath: () => userData }, { profileDataRoot, dbPath, auditLogs: false });
    await seedEngine.init(null);
    await seedEngine.saveProfile({ id: 'nr-1', name: 'NoRoot 1' });
    seedEngine.sqliteStore.close();
    // Ensure profileDataRoot still didn't exist if saveProfile created it? Wait: saveProfile creates it via createDir:true -> verify lock db exists!
    assert.equal(fs.existsSync(path.join(profileDataRoot, '.openbrowser-delete.lock.db')), true, 'kernel lock db initialized even before browser launch');
  }

  // 17e. onlyIfTrashed must NOT stop() an already-restored running browser
  {
    const { engine } = await createIsolatedEngine(root, { subdir: 't17e-nostop-restored' });
    try {
      await seedProfile(engine, 'r-live', { number: 1, withDisk: true });
      await engine.trashProfiles(['r-live']);

      let stopCalls = 0;
      engine.stop = async (id) => {
        stopCalls += 1;
        engine.running.delete(id);
        return { id, running: false };
      };

      const origPurge = engine.purgeProfiles.bind(engine);
      engine.purgeProfiles = async (ids, deleteData, opts) => {
        await engine.restoreProfiles(['r-live']);
        engine.running.set('r-live', { pid: 88888, cleanedUp: false, stopping: false });
        return origPurge(ids, deleteData, opts);
      };

      const res = await engine.emptyTrash(true);
      assert.equal(res.deleted, 0);
      assert.equal(stopCalls, 0, 'onlyIfTrashed must NOT call stop() on already-restored running browser');
      assert.equal(engine.running.has('r-live'), true);
      assert.equal(engine.profiles.get('r-live')?.trashed, false);
    } finally {
      try { engine.sqliteStore?.close(); } catch (_) {}
    }
  }

  console.log('  PASS  Dual-process stale cache, _start no-resurrection, no-root lock, and onlyIfTrashed no-stop verified');
}

async function testEnsureExitNetworkAndRecoveryAuthoritativeStore(root) {
  console.log('\n--- [Test 18] ensureExitNetworkForLocale No-Resurrection & Recovery Authoritative Store ---');
  const engineJsPath = path.resolve(__dirname, '../engine.js');
  const sqliteModulePath = path.resolve(__dirname, '../automation/profile-store-sqlite.js');

  // 18a. Dual OS processes: _start() -> ensureExitNetworkForLocale() must NOT resurrect p-del deleted by Child B (SQLite + JSON)
  {
    const { engine: engineA, userData, profileDataRoot, dbPath } = await createIsolatedEngine(root, { subdir: 't18a-exitnet-sqlite' });
    try {
      const pAlive = await seedProfile(engineA, 'en-alive', { number: 1, withDisk: true });
      engineA.networkInfo.delete('en-alive');
      pAlive.networkMode = 'proxy';
      pAlive.proxy = 'http://127.0.0.1:8080';
      pAlive.privacy = { ...pAlive.privacy, languageMode: 'ip', timezoneMode: 'ip' };
      engineA.sqliteStore.saveProfiles([pAlive]);
      engineA.profiles.set('en-alive', pAlive);
      await seedProfile(engineA, 'en-del', { number: 2, withDisk: true });

      let enteredCheckProxy;
      const checkProxyEntered = new Promise((resolve) => { enteredCheckProxy = resolve; });
      let releaseCheckProxy;
      const checkProxyGate = new Promise((resolve) => { releaseCheckProxy = resolve; });

      engineA.prepareProfileProxyForStart = async (prof) => prof;
      engineA.checkProxy = async () => {
        enteredCheckProxy();
        await checkProxyGate;
        return { ip: '203.0.113.55', countryCode: 'JP', timezone: 'Asia/Tokyo', latitude: 35.6, longitude: 139.7 };
      };
      engineA.chooseBrowser = () => {
        throw new Error('STOP_AT_CHOOSE_BROWSER');
      };

      const startTask = engineA.start(pAlive).then(() => ({ ok: true }), (err) => ({ ok: false, err }));
      await Promise.race([
        checkProxyEntered,
        startTask.then((r) => { throw new Error(`startTask ended before checkProxy: ${r.err?.message || r.ok}`); }),
      ]);

      // While Process A is awaiting network inside ensureExitNetworkForLocale, Child B deletes en-del
      const childDelCode = `
        const { BrowserEngine } = require(${JSON.stringify(engineJsPath)});
        (async () => {
          const engine = new BrowserEngine(
            { getPath: () => ${JSON.stringify(userData)} },
            { profileDataRoot: ${JSON.stringify(profileDataRoot)}, dbPath: ${JSON.stringify(dbPath)}, auditLogs: false }
          );
          await engine.init(null);
          await engine.deleteProfiles(['en-del'], true);
          engine.sqliteStore.close();
        })();
      `;
      await new Promise((resolve, reject) => {
        const child = cp.spawn(process.execPath, ['-e', childDelCode], { stdio: ['ignore', 'pipe', 'pipe'] });
        let err = '';
        child.stderr.on('data', (d) => { err += d.toString(); });
        child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ChildDel failed (${code}): ${err}`))));
      });

      releaseCheckProxy();
      const startRes = await startTask;
      assert.equal(startRes.ok, false);
      assert.match(startRes.err.message, /STOP_AT_CHOOSE_BROWSER/);
      assert.equal(engineA.sqliteStore.getProfile('en-del'), null, 'ensureExitNetworkForLocale must NOT resurrect en-del in SQLite');
      assert.equal(fs.existsSync(engineA.profileRoot('en-del')), false);
      assert.equal(engineA.sqliteStore.getProfile('en-alive')?.exitIp, '203.0.113.55');
    } finally {
      try { engineA.sqliteStore?.close(); } catch (_) {}
    }
  }

  // JSON mode ensureExitNetworkForLocale no-resurrection
  {
    const { ProfileStoreSqlite } = require('../automation/profile-store-sqlite');
    const origSupported = ProfileStoreSqlite.isSupported;
    ProfileStoreSqlite.isSupported = () => false;
    try {
      const userData = path.join(root, 't18a-exitnet-json');
      const profileDataRoot = path.join(userData, 'browser-profiles-v2');
      await fsp.mkdir(userData, { recursive: true });
      const engineA = new BrowserEngine({ getPath: () => userData }, { profileDataRoot, auditLogs: false });
      await engineA.init(null);
      await engineA.syncProfiles([
        { id: 'jen-alive', number: 1, name: 'JAlive', networkMode: 'proxy', proxy: 'http://127.0.0.1:8080', privacy: { languageMode: 'ip', timezoneMode: 'ip' } },
        { id: 'jen-del', number: 2, name: 'JDel' },
      ]);
      const pAlive = engineA.profiles.get('jen-alive');

      let enteredCheckProxy;
      const checkProxyEntered = new Promise((resolve) => { enteredCheckProxy = resolve; });
      let releaseCheckProxy;
      const checkProxyGate = new Promise((resolve) => { releaseCheckProxy = resolve; });

      engineA.prepareProfileProxyForStart = async (prof) => prof;
      engineA.checkProxy = async () => {
        enteredCheckProxy();
        await checkProxyGate;
        return { ip: '203.0.113.66', countryCode: 'DE', timezone: 'Europe/Berlin', latitude: 52.5, longitude: 13.4 };
      };
      engineA.chooseBrowser = () => {
        throw new Error('STOP_AT_CHOOSE_BROWSER');
      };

      const startTask = engineA.start(pAlive).then(() => ({ ok: true }), (err) => ({ ok: false, err }));
      await Promise.race([
        checkProxyEntered,
        startTask.then((r) => { throw new Error(`startTask ended before checkProxy: ${r.err?.message || r.ok}`); }),
      ]);

      const childJsonDel = `
        const { ProfileStoreSqlite } = require(${JSON.stringify(sqliteModulePath)});
        ProfileStoreSqlite.isSupported = () => false;
        const { BrowserEngine } = require(${JSON.stringify(engineJsPath)});
        (async () => {
          const engine = new BrowserEngine(
            { getPath: () => ${JSON.stringify(userData)} },
            { profileDataRoot: ${JSON.stringify(profileDataRoot)}, auditLogs: false }
          );
          await engine.init(null);
          await engine.deleteProfiles(['jen-del'], true);
        })();
      `;
      await new Promise((resolve, reject) => {
        const child = cp.spawn(process.execPath, ['-e', childJsonDel], { stdio: ['ignore', 'pipe', 'pipe'] });
        let err = '';
        child.stderr.on('data', (d) => { err += d.toString(); });
        child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ChildJsonDel failed (${code}): ${err}`))));
      });

      releaseCheckProxy();
      const startRes = await startTask;
      assert.equal(startRes.ok, false);
      assert.match(startRes.err.message, /STOP_AT_CHOOSE_BROWSER/);
      const stateCandidate = await require('../engine/state-storage').readEngineStateCandidate(engineA.stateFile);
      assert.equal(stateCandidate.saved.profiles.some((p) => p.id === 'jen-del'), false, 'JSON ensureExitNetworkForLocale must NOT resurrect jen-del');
    } finally {
      ProfileStoreSqlite.isSupported = origSupported;
    }
  }

  // 18b. Dual OS processes: Child B crashes post-DB-commit leaving manifest='staging' on disk;
  //      Process A holding stale this.profiles MUST rely on authoritative persistent store (absent) and clean up (NOT restore!)
  {
    const { engine: engineA, userData, profileDataRoot, dbPath } = await createIsolatedEngine(root, { subdir: 't18b-recovery-stale-mem' });
    try {
      await seedProfile(engineA, 'stale-rec-1', { number: 1, withDisk: true });
      await fsp.writeFile(path.join(engineA.profileRoot('stale-rec-1'), 'marker.txt'), 'SHOULD_BE_CLEANED', 'utf8');
      assert.equal(engineA.profiles.has('stale-rec-1'), true);

      // Child B commits DB deletion, fails to update manifest to 'committed', and SIGKILLs before rm
      const childCrashCode = `
        const fs = require('node:fs');
        const fsp = require('node:fs/promises');
        const path = require('node:path');
        const { BrowserEngine } = require(${JSON.stringify(engineJsPath)});
        (async () => {
          const engine = new BrowserEngine(
            { getPath: () => ${JSON.stringify(userData)} },
            { profileDataRoot: ${JSON.stringify(profileDataRoot)}, dbPath: ${JSON.stringify(dbPath)}, auditLogs: false }
          );
          await engine.init(null);
          const origRename = fsp.rename;
          fsp.rename = async (src, dst) => {
            if (path.basename(dst) === '.manifest.json' && path.basename(path.dirname(dst)).startsWith('.ob-del-') && fs.existsSync(dst)) {
              // Simulate crash right after DB commit before manifest update (without writing committed or meta)
              process.kill(process.pid, 'SIGKILL');
            }
            return origRename(src, dst);
          };
          await engine.deleteProfiles(['stale-rec-1'], true);
        })();
      `;
      await new Promise((resolve, reject) => {
        const child = cp.spawn(process.execPath, ['-e', childCrashCode], { stdio: ['ignore', 'pipe', 'pipe'] });
        child.on('exit', (code, signal) => (signal === 'SIGKILL' ? resolve() : reject(new Error(`Expected SIGKILL, got code=${code} signal=${signal}`))));
      });

      assert.equal(engineA.sqliteStore.getProfile('stale-rec-1'), null);
      assert.equal(engineA.profiles.has('stale-rec-1'), true, 'Process A still has stale in-memory entry');
      assert.equal(fs.existsSync(engineA.profileRoot('stale-rec-1')), false);

      // Process A runs recovery -> MUST trust authoritative DB (absent), NOT stale engineA.profiles, and clean up!
      await engineA.recoverDeleteStagingLeftovers();
      assert.equal(fs.existsSync(engineA.profileRoot('stale-rec-1')), false, 'must NOT restore directory deleted in DB via stale mem');
      assert.deepEqual(listDeleteStagingDirs(profileDataRoot), [], 'orphaned staging dir cleaned cleanly');
    } finally {
      try { engineA.sqliteStore?.close(); } catch (_) {}
    }
  }

  // 18c. Uninitialized engine with stale this.profiles & no persistent store MUST fail closed and preserve staged data
  {
    const userData = path.join(root, 't18c-uninit-stale-mem');
    const profileDataRoot = path.join(userData, 'browser-profiles-v2');
    await fsp.mkdir(profileDataRoot, { recursive: true });
    const uninitEngine = new BrowserEngine({ getPath: () => userData }, { profileDataRoot, auditLogs: false });
    uninitEngine.profiles.set('uninit-stale', uninitEngine.sanitizeProfile({ id: 'uninit-stale', name: 'Stale' }));

    const bDir = path.join(profileDataRoot, '.ob-del-uninitstale');
    await fsp.mkdir(path.join(bDir, 'uninit-stale'), { recursive: true });
    await fsp.writeFile(path.join(bDir, 'uninit-stale', 'marker.txt'), 'KEEP_UNVERIFIABLE', 'utf8');
    await fsp.writeFile(path.join(bDir, '.manifest.json'), JSON.stringify(makeManifest({
      state: 'staging',
      ids: ['uninit-stale'],
    })), 'utf8');

    const rec = await uninitEngine.recoverDeleteStagingLeftovers();
    assert.equal(rec.failedRestoreIds.has('uninit-stale'), true);
    assert.equal(fs.existsSync(uninitEngine.profileRoot('uninit-stale')), false);
    assert.equal(fs.readFileSync(path.join(bDir, 'uninit-stale', 'marker.txt'), 'utf8'), 'KEEP_UNVERIFIABLE');
  }

  console.log('  PASS  ensureExitNetworkForLocale no-resurrection and authoritative store recovery verified');
}

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-del-consistency-'));
  console.log(`Running deleteProfiles consistency selftest in isolated root: ${tempRoot}`);
  try {
    await testHappyPathSqlite(tempRoot);
    await testRetainData(tempRoot);
    await testSqliteFailureRollback(tempRoot);
    await testLegacyJsonPersistRollback(tempRoot);
    await testMidwayStagingFailureRollback(tempRoot);
    await testPostCommitCleanupFailureAndDeferredRecovery(tempRoot);
    await testRealChildSigkillPreCommitAndPostCommit(tempRoot);
    await testSimulatedCrashEdgeCasesAndLivePid(tempRoot);
    await testIsolationSymlinkConcurrencyAndPartialRollback(tempRoot);
    await testRecoveryBeforeStartAndJsonInit(tempRoot);
    await testUnknownStagingDirsAndStrictManifestValidation(tempRoot);
    await testFailClosedWhenStoreUnverifiable(tempRoot);
    await testCorruptedRowConflictAndUnverifiableStart(tempRoot);
    await testConcurrencyRebuildClockJumpAndLstatError(tempRoot);
    await testExternalLocksStopRaceBatchMutexAndCrossProcess(tempRoot);
    await testEmptyTrashRaceCrossProcessSaveAndStagedLockRelease(tempRoot);
    await testDualProcessStaleCacheStartPersistAndNoRootLock(tempRoot);
    await testEnsureExitNetworkAndRecoveryAuthoritativeStore(tempRoot);
    console.log('\nALL deleteProfiles CONSISTENCY TESTS PASSED!');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('SELFTEST FAILED:', err);
  process.exit(1);
});
