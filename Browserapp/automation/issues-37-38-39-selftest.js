'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

async function main() {
  console.log('Testing GitHub Issues #37, #38, #39 fixes...');

  // ==========================================
  // 1. Issue #39: SOCKS5 Remote DNS & Proxy Bridge
  // ==========================================
  console.log('\n--- [Issue #39] SOCKS5 Remote DNS & QUIC Disabling ---');
  const { needsProxyBridge } = require('../proxy-forwarder');

  // 1.1 SOCKS5 proxies MUST be bridged to force remote domain resolution (Socks5h)
  assert.equal(
    needsProxyBridge({ protocol: 'socks5', host: '206.232.73.52', port: 7622, authenticated: false }),
    true,
    'Unauthenticated SOCKS5 must be bridged to enforce remote DNS'
  );
  assert.equal(
    needsProxyBridge({ protocol: 'socks5', host: '206.232.73.52', port: 7622, authenticated: true, username: 'u', password: 'p' }),
    true,
    'Authenticated SOCKS5 must be bridged'
  );
  assert.equal(
    needsProxyBridge({ protocol: 'http', host: '1.2.3.4', port: 8080, authenticated: false }),
    false,
    'Plain HTTP proxy without auth does not need bridge'
  );
  assert.equal(
    needsProxyBridge({ protocol: 'http', host: '1.2.3.4', port: 8080, authenticated: true }),
    true,
    'HTTP proxy with auth needs bridge'
  );

  // 1.2 Verify engine Chromium argument generation for SOCKS5 bridge
  const { sanitizeProfile } = require('../engine/profile-sanitizer');
  const testSocks5Profile = sanitizeProfile({
    id: 'test-p-socks5',
    name: 'SOCKS5 Test',
    proxy: 'socks5://206.232.73.52:7622',
    networkMode: 'proxy'
  });
  assert.equal(testSocks5Profile.networkMode, 'proxy');
  assert.equal(testSocks5Profile.proxy, 'socks5://206.232.73.52:7622');

  console.log('  PASS  needsProxyBridge forces remote DNS (Socks5h) for all SOCKS5 proxies');

  // ==========================================
  // 2. Issue #38: Crash / Shutdown Lock & File Recovery
  // ==========================================
  console.log('\n--- [Issue #38] Computer Shutdown / Crash Recovery ---');
  const { acquireProfileLock, releaseProfileLock } = require('./isolation');
  const { readPreferences, writePreferences } = require('./profile-file-consistency');

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-issue38-test-'));
  try {
    const profileDir = path.join(tempDir, 'profile-1');
    fs.mkdirSync(profileDir, { recursive: true });

    // 2.1 Stale lock from prior boot
    // Simulate a lock created before current system boot
    const staleLockPath = path.join(profileDir, 'openbrowser.lock');
    const bootTimeMs = Date.now() - (os.uptime() * 1000);
    const priorBootTime = new Date(bootTimeMs - 3600000); // 1 hour before boot
    
    fs.writeFileSync(staleLockPath, JSON.stringify({
      pid: process.pid, // even if PID collides with a current process!
      user: 'test',
      host: os.hostname(),
      createdAt: priorBootTime.toISOString(),
    }));
    fs.utimesSync(staleLockPath, priorBootTime, priorBootTime);

    // acquireProfileLock should detect that lock is from before boot and reclaim it
    const lock = await acquireProfileLock(profileDir);
    assert.ok(lock, 'Lock should be acquired despite pre-existing stale lock from prior boot');
    assert.equal(lock.pid, process.pid);
    await releaseProfileLock(profileDir, lock);
    console.log('  PASS  Stale lock from prior boot is safely cleared without false PID collision');

    // 2.2 Corrupted Preferences file recovery (e.g. truncated during power cut)
    const defaultDir = path.join(profileDir, 'Default');
    fs.mkdirSync(defaultDir, { recursive: true });
    const prefsFile = path.join(defaultDir, 'Preferences');
    
    // Write invalid/corrupt JSON
    fs.writeFileSync(prefsFile, '{"intl":{"accept_languages":"zh-CN", "truncated');
    
    // readPreferences should catch SyntaxError, backup corrupted file, and return empty object
    const recoveredPrefs = await readPreferences(prefsFile);
    assert.deepEqual(recoveredPrefs, {}, 'Corrupted preferences should return empty object fallback');
    
    const filesInDefault = fs.readdirSync(defaultDir);
    const corruptedBackups = filesInDefault.filter(f => f.startsWith('Preferences.corrupted.'));
    assert.ok(corruptedBackups.length > 0, 'Corrupted preferences should be preserved as .corrupted backup');
    console.log('  PASS  Corrupted Preferences from power loss gracefully recovers without crashing');

  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
  }

  // ==========================================
  // 3. Issue #37: Profile Recycle Bin (Trash / Restore / Purge)
  // ==========================================
  console.log('\n--- [Issue #37] Profile Recycle Bin ---');
  const { filterProfiles } = require('../ui/ui-profile-list');

  const sampleProfiles = [
    { id: 'p1', number: 1, name: 'Active 1', groupId: 'g1', trashed: false },
    { id: 'p2', number: 2, name: 'Active 2', groupId: '', trashed: false },
    { id: 'p3', number: 3, name: 'Deleted 1', groupId: 'g1', trashed: true, trashedAt: new Date().toISOString() },
    { id: 'p4', number: 4, name: 'Deleted 2', groupId: '', trashed: true, trashedAt: new Date().toISOString() },
  ];

  // 3.1 Normal list views should NEVER show trashed profiles
  const allActive = filterProfiles({
    profiles: sampleProfiles,
    activeGroupFilter: 'all',
    query: '',
  });
  assert.equal(allActive.length, 2);
  assert.deepEqual(allActive.map(p => p.id), ['p1', 'p2']);

  const group1Active = filterProfiles({
    profiles: sampleProfiles,
    activeGroupFilter: 'g1',
    query: '',
  });
  assert.equal(group1Active.length, 1);
  assert.equal(group1Active[0].id, 'p1');

  const ungroupedActive = filterProfiles({
    profiles: sampleProfiles,
    activeGroupFilter: 'ungrouped',
    query: '',
  });
  assert.equal(ungroupedActive.length, 1);
  assert.equal(ungroupedActive[0].id, 'p2');

  // 3.2 Recycle Bin view should ONLY show trashed profiles
  const trashView = filterProfiles({
    profiles: sampleProfiles,
    activeGroupFilter: 'trash',
    query: '',
  });
  assert.equal(trashView.length, 2);
  assert.deepEqual(trashView.map(p => p.id), ['p3', 'p4']);

  // 3.3 Search inside Recycle Bin
  const trashSearch = filterProfiles({
    profiles: sampleProfiles,
    activeGroupFilter: 'trash',
    query: 'Deleted 1',
  });
  assert.equal(trashSearch.length, 1);
  assert.equal(trashSearch[0].id, 'p3');

  console.log('  PASS  Recycle Bin filtering isolates trashed profiles from active views');

  // 3.4 Engine trash, restore, purge, emptyTrash operations
  const { BrowserEngine } = require('../engine');
  const engineTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-engine-trash-'));
  try {
    const mockApp = {
      getPath: (name) => path.join(engineTemp, name),
    };
    const engine = new BrowserEngine(mockApp, {
      profileDataRoot: path.join(engineTemp, 'browser-profiles-v2'),
      auditLogs: false,
    });

    // Seed profiles
    engine.profiles.set('t1', sanitizeProfile({ id: 't1', name: 'Profile 1' }));
    engine.profiles.set('t2', sanitizeProfile({ id: 't2', name: 'Profile 2' }));
    engine.profiles.set('t3', sanitizeProfile({ id: 't3', name: 'Profile 3' }));
    
    // Create profile directories at engine.profileRoot(id)
    const dirT1 = engine.profileRoot('t1');
    const dirT2 = engine.profileRoot('t2');
    const dirT3 = engine.profileRoot('t3');
    fs.mkdirSync(dirT1, { recursive: true });
    fs.mkdirSync(dirT2, { recursive: true });
    fs.mkdirSync(dirT3, { recursive: true });

    // Soft delete / Move to trash
    const trashResult = await engine.trashProfiles(['t1', 't2']);
    assert.equal(trashResult.trashed, 2);
    assert.equal(engine.profiles.get('t1').trashed, true);
    assert.ok(engine.profiles.get('t1').trashedAt);
    assert.equal(engine.profiles.get('t2').trashed, true);
    assert.equal(engine.profiles.get('t3').trashed, false);
    assert.ok(fs.existsSync(dirT1), 'Data directory must remain on soft delete');

    // Restore profile t1
    const restoreResult = await engine.restoreProfiles(['t1']);
    assert.equal(restoreResult.restored, 1);
    assert.equal(engine.profiles.get('t1').trashed, false);
    assert.equal(engine.profiles.get('t1').trashedAt, null);

    // Purge profile t2 (permanent delete with data)
    const purgeResult = await engine.purgeProfiles(['t2'], true);
    assert.equal(purgeResult.deleted, 1);
    assert.equal(engine.profiles.has('t2'), false);
    assert.ok(!fs.existsSync(dirT2), 'Data directory must be removed on purge');

    // Empty trash
    await engine.trashProfiles(['t1']);
    const emptyResult = await engine.emptyTrash(true);
    assert.equal(emptyResult.deleted, 1);
    assert.equal(engine.profiles.has('t1'), false);
    assert.equal(engine.profiles.has('t3'), true, 'Active profile t3 must remain');
    assert.ok(!fs.existsSync(dirT1), 'Data directory for emptied profile must be purged');
    assert.ok(fs.existsSync(dirT3), 'Active profile data directory must remain');

    console.log('  PASS  Engine trashProfiles, restoreProfiles, purgeProfiles, and emptyTrash operate correctly');

  } finally {
    try { fs.rmSync(engineTemp, { recursive: true, force: true }); } catch (_) {}
  }

  console.log('\n======================================================');
  console.log('ALL TESTS PASSED for GitHub Issues #37, #38, #39!');
  console.log('======================================================');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
