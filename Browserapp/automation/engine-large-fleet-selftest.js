'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const { BrowserEngine } = require('../engine');
const { ProfileStoreSqlite } = require('./profile-store-sqlite');

async function main() {
  console.log('Running Large Fleet (1500+ Profiles) Backend Modernization Selftest...');

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-largefleet-test-'));
  const profileDataRoot = path.join(tempDir, 'profiles-data');
  fs.mkdirSync(profileDataRoot, { recursive: true });

  const dbPath = path.join(tempDir, 'openbrowser-data.db');
  const mockApp = {
    getPath: (name) => {
      if (name === 'userData') return tempDir;
      return tempDir;
    },
  };

  try {
    // -------------------------------------------------------------
    // Step 1: Pre-populate SQLite store with 1500 profiles
    // -------------------------------------------------------------
    console.log('\n--- [Step 1] Seeding SQLite database with 1500 profiles ---');
    const store = new ProfileStoreSqlite({
      dbPath,
      profileDataRoot,
    });
    await store.init();

    const seedProfiles = [];
    for (let i = 1; i <= 1500; i += 1) {
      seedProfiles.push({
        id: `profile-${i}`,
        number: i,
        name: `Fleet Profile ${i}`,
        title: `Title ${i}`,
        tag: i % 2 === 0 ? 'even-tag' : 'odd-tag',
        groupId: i <= 500 ? 'group-a' : (i <= 1000 ? 'group-b' : null),
        proxy: i % 10 === 0 ? `socks5://127.0.0.1:${10000 + i}` : 'direct',
        cookies: `token_${i}=secret_cookie_${i}`,
        platform: {
          username: `user_${i}`,
          password: `pass_${i}`,
          totpSecret: `totp_${i}`,
          startUrl: `https://site-${i}.com`,
        },
        trashed: false,
        createdAt: new Date(Date.now() - (1500 - i) * 1000).toISOString(),
        updatedAt: new Date(Date.now() - (1500 - i) * 1000).toISOString(),
      });
    }

    const t0 = Date.now();
    store.saveProfiles(seedProfiles);
    const seedDuration = Date.now() - t0;
    console.log(`Seeded 1500 profiles into SQLite in ${seedDuration}ms`);
    store.close();

    // -------------------------------------------------------------
    // Step 2: Initialize BrowserEngine & Verify Fleet Full Load (No 1000 Hard Limit)
    // -------------------------------------------------------------
    console.log('\n--- [Step 2] Testing Engine initialization and 1000-profile truncation removal ---');
    const engine = new BrowserEngine(mockApp, {
      profileDataRoot,
      dbPath,
    });
    await engine.init();

    assert.equal(engine.usingSqlite, true, 'Engine must use SQLite store');
    assert.equal(engine.profiles.size, 1500, 'Engine must load all 1500 profiles without 1000-truncation');

    const p1200 = engine.profiles.get('profile-1200');
    assert.ok(p1200, 'Profile 1200 must be in memory beyond the old 1000 cap');
    assert.equal(p1200.name, 'Fleet Profile 1200');
    console.log('  PASS  Loaded 1500 profiles successfully into engine.profiles');

    // -------------------------------------------------------------
    // Step 3: getProfileCounts and getNextProfileNumber
    // -------------------------------------------------------------
    console.log('\n--- [Step 3] Testing getProfileCounts & getNextProfileNumber ---');
    const counts = engine.getProfileCounts();
    assert.equal(counts.total, 1500, 'Total counts must be 1500');
    assert.equal(counts.active, 1500, 'Active counts must be 1500');
    assert.equal(counts.trashed, 0, 'Trashed counts must be 0');
    assert.equal(counts.ungrouped, 500, 'Ungrouped counts must be 500');
    assert.equal(counts.byGroup['group-a'], 500, 'group-a count must be 500');
    assert.equal(counts.byGroup['group-b'], 500, 'group-b count must be 500');

    const nextNum = engine.getNextProfileNumber();
    assert.equal(nextNum, 1501, 'Next sequence number must be 1501');
    console.log('  PASS  getProfileCounts & getNextProfileNumber accurate');

    // -------------------------------------------------------------
    // Step 4: saveProfile (Incremental single-profile write)
    // -------------------------------------------------------------
    console.log('\n--- [Step 4] Testing saveProfile incremental write & credential preservation ---');
    const newProfile = {
      id: 'profile-new-1',
      name: 'New Profile 1',
      number: nextNum,
      proxy: 'socks5://127.0.0.1:19999',
      cookies: 'my_cookie=123',
      platform: { password: 'my_secret_password' },
    };
    const saveRes = await engine.saveProfile(newProfile);
    assert.equal(saveRes.success, true);
    assert.equal(engine.profiles.get('profile-new-1')?.name, 'New Profile 1');

    // Verify written to SQLite directly
    const storedNew = engine.sqliteStore.getProfile('profile-new-1');
    assert.ok(storedNew, 'New profile must exist in SQLite');
    assert.equal(storedNew.cookies, 'my_cookie=123');
    assert.equal(storedNew.platform?.password, 'my_secret_password');

    const encryptCredential = require('../credential-crypto').encryptCredential;
    const cryptoModule = require('../credential-crypto');
    cryptoModule.encryptCredential = () => { throw new Error('injected encryption failure'); };
    try {
      await assert.rejects(engine.saveProfile({ ...newProfile, name: 'Must Roll Back' }), /injected encryption failure/);
      assert.equal(engine.profiles.get(newProfile.id).name, 'New Profile 1');
      assert.equal(engine.sqliteStore.getProfile(newProfile.id).name, 'New Profile 1');
      await assert.rejects(engine.syncProfiles([{ ...newProfile, name: 'Must Also Roll Back' }]), /injected encryption failure/);
      assert.equal(engine.profiles.get(newProfile.id).name, 'New Profile 1');
      assert.equal(engine.sqliteStore.getProfile(newProfile.id).name, 'New Profile 1');
      await assert.rejects(engine.batchPatchProfiles({ ids: [newProfile.id], patch: { name: 'Patch Roll Back' } }), /injected encryption failure/);
      assert.equal(engine.profiles.get(newProfile.id).name, 'New Profile 1');
      const sizeBeforeClone = engine.profiles.size;
      await assert.rejects(engine.cloneProfiles({ ids: [newProfile.id] }), /injected encryption failure/);
      assert.equal(engine.profiles.size, sizeBeforeClone);
      await assert.rejects(engine.renumberProfiles(), /injected encryption failure/);
      assert.equal(engine.profiles.get(newProfile.id).name, 'New Profile 1');
    } finally {
      cryptoModule.encryptCredential = encryptCredential;
    }
    console.log('  PASS  Failed encryption rolls back single and batch profile state');

    // Incremental update preserving secrets
    await engine.saveProfile({
      id: 'profile-new-1',
      name: 'New Profile 1 Updated',
      number: nextNum,
      proxy: 'socks5://127.0.0.1:19999',
      cookies: '', // redacted
      platform: { password: '' }, // redacted
    });
    const updatedMem = engine.getProfile('profile-new-1');
    assert.equal(updatedMem.name, 'New Profile 1 Updated');
    assert.equal(updatedMem.cookies, 'my_cookie=123', 'Old cookies must be preserved when UI redacts');
    assert.equal(updatedMem.platform?.password, 'my_secret_password', 'Old password must be preserved when UI redacts');
    console.log('  PASS  saveProfile incremental write and credential preservation verified');

    // -------------------------------------------------------------
    // Step 5: cloneProfiles (Batch cloning)
    // -------------------------------------------------------------
    console.log('\n--- [Step 5] Testing cloneProfiles with sequence and credential wipe ---');
    const cloneRes = await engine.cloneProfiles({ ids: ['profile-1200', 'profile-1201'] });
    assert.equal(cloneRes.success, true);
    assert.equal(cloneRes.count, 2);
    assert.equal(cloneRes.profiles.length, 2);

    const c1 = cloneRes.profiles[0];
    const c2 = cloneRes.profiles[1];
    assert.notEqual(c1.id, 'profile-1200');
    assert.equal(c1.number, 1502);
    assert.equal(c2.number, 1503);
    assert.equal(c1.cookies, '', 'Cloned profile must wipe cookies');
    assert.equal(c1.platform?.password, '', 'Cloned profile must wipe passwords');
    assert.equal(c1.platform?.totpSecret, '', 'Cloned profile must wipe totp');
    assert.ok(!c1.exitIp, 'Cloned profile must wipe exitIp');

    // Check presence in SQLite
    const storedC1 = engine.sqliteStore.getProfile(c1.id);
    assert.ok(storedC1, 'Cloned profile must be written to SQLite');
    assert.equal(storedC1.number, 1502);
    console.log('  PASS  cloneProfiles allocated sequence and wiped credentials');

    // -------------------------------------------------------------
    // Step 6: batchPatchProfiles
    // -------------------------------------------------------------
    console.log('\n--- [Step 6] Testing batchPatchProfiles ---');
    const patchRes = await engine.batchPatchProfiles({
      ids: ['profile-1200', 'profile-1201'],
      groupId: 'group-patched',
      startUrl: 'https://patched-url.org',
      os: 'win',
    });
    assert.equal(patchRes.success, true);
    assert.equal(patchRes.count, 2);

    const patched1200 = engine.getProfile('profile-1200');
    assert.equal(patched1200.groupId, 'group-patched');
    assert.equal(patched1200.platform?.startUrl, 'https://patched-url.org');
    assert.equal(patched1200.os, 'win');

    const stored1200 = engine.sqliteStore.getProfile('profile-1200');
    assert.equal(stored1200.groupId, 'group-patched');
    assert.equal(stored1200.platform?.startUrl, 'https://patched-url.org');
    console.log('  PASS  batchPatchProfiles successfully applied changes to target profiles');

    // -------------------------------------------------------------
    // Step 7: renumberProfiles
    // -------------------------------------------------------------
    console.log('\n--- [Step 7] Testing renumberProfiles ---');
    const renumRes = await engine.renumberProfiles();
    assert.equal(renumRes.success, true);
    const totalCountNow = engine.profiles.size; // 1500 + 1 (new) + 2 (clones) = 1503
    assert.equal(renumRes.count, totalCountNow);

    const allProfiles = engine.sqliteStore.getAllProfiles();
    allProfiles.sort((a, b) => a.number - b.number);
    for (let i = 0; i < allProfiles.length; i += 1) {
      assert.equal(allProfiles[i].number, i + 1, `Profile at index ${i} must have number ${i + 1}`);
      assert.equal(allProfiles[i].name, String(i + 1), `Profile name must be renumbered to ${i + 1}`);
    }
    console.log('  PASS  renumberProfiles successfully re-sequenced all profiles 1..N');

    // -------------------------------------------------------------
    // Step 8: trashProfiles, restoreProfiles, emptyTrash on profile-1200
    // -------------------------------------------------------------
    console.log('\n--- [Step 8] Testing trash, restore, and emptyTrash at 1200 boundary ---');
    const trashRes = await engine.trashProfiles(['profile-1200']);
    assert.equal(trashRes.success, true);
    assert.equal(trashRes.trashed, 1);
    assert.equal(engine.getProfile('profile-1200').trashed, true);

    const countsAfterTrash = engine.getProfileCounts();
    assert.equal(countsAfterTrash.trashed, 1);

    const restoreRes = await engine.restoreProfiles(['profile-1200']);
    assert.equal(restoreRes.success, true);
    assert.equal(restoreRes.restored, 1);
    assert.equal(engine.getProfile('profile-1200').trashed, false);
    assert.equal(engine.getProfileCounts().trashed, 0);

    // Trash and emptyTrash
    await engine.trashProfiles(['profile-1200']);
    const emptyRes = await engine.emptyTrash(false);
    assert.equal(emptyRes.success, true);
    assert.ok(emptyRes.deleted >= 1);
    assert.equal(engine.profiles.has('profile-1200'), false, 'Profile 1200 must be removed from memory');
    assert.equal(engine.sqliteStore.getProfile('profile-1200'), null, 'Profile 1200 must be removed from SQLite');
    assert.equal(engine.getProfileCounts().trashed, 0);
    console.log('  PASS  trash, restore, and emptyTrash passed on 1200-numbered profile');

    // -------------------------------------------------------------
    // Step 9: queryProfilesPage (SQLite and Non-SQLite parity)
    // -------------------------------------------------------------
    console.log('\n--- [Step 9] Testing queryProfilesPage (counts, filter, projection) ---');
    // 9.1 SQLite path
    const pageSqlite = engine.queryProfilesPage({
      page: 1,
      pageSize: 20,
      filters: { groupId: 'group-patched' },
    });
    assert.ok(pageSqlite.counts, 'Must include counts object in SQLite result');
    assert.equal(pageSqlite.rows.length, 1); // profile-1201 (since 1200 was deleted)
    assert.equal(pageSqlite.rows[0]._isSummaryProjection, true);
    assert.equal(pageSqlite.rows[0].id, 'profile-1201');

    // 9.2 Non-SQLite fallback path
    engine.usingSqlite = false;
    const pageFallback = engine.queryProfilesPage({
      page: 1,
      pageSize: 20,
      filters: { groupId: 'group-patched' },
    });
    assert.ok(pageFallback.counts, 'Must include counts object in non-SQLite fallback');
    assert.equal(pageFallback.rows.length, 1);
    assert.equal(pageFallback.rows[0]._isSummaryProjection, true);
    assert.equal(pageFallback.rows[0].id, 'profile-1201');
    assert.ok('note' in pageFallback.rows[0] && 'notes' in pageFallback.rows[0]);

    // Test search filter across fields in fallback
    const pageSearch = engine.queryProfilesPage({
      filters: { search: 'odd-tag' },
      pageSize: 10,
    });
    assert.ok(pageSearch.rows.length > 0);
    for (const r of pageSearch.rows) {
      assert.equal(r.tag, 'odd-tag');
    }

    // Restore engine.usingSqlite
    engine.usingSqlite = true;
    console.log('  PASS  queryProfilesPage verified with full SQLite and non-SQLite parity');

    // -------------------------------------------------------------
    // Step 10: Security Guardrails & Boundary Verification
    // -------------------------------------------------------------
    console.log('\n--- [Step 10] Testing Security Guardrails & Boundary Handling ---');
    // 10.1 50000 boundary guardrail
    const overLimitIds = new Array(50001).fill('profile-1');
    await assert.rejects(
      async () => engine.trashProfiles(overLimitIds),
      /Invalid profile selection/,
      'trashProfiles must reject >50000 ids'
    );
    await assert.rejects(
      async () => engine.restoreProfiles(overLimitIds),
      /Invalid profile selection/,
      'restoreProfiles must reject >50000 ids'
    );
    await assert.rejects(
      async () => engine.deleteProfiles(overLimitIds),
      /Invalid profile selection/,
      'deleteProfiles must reject >50000 ids'
    );
    await assert.rejects(
      async () => engine.batchPatchProfiles({ ids: overLimitIds }),
      /Invalid profile selection/,
      'batchPatchProfiles must reject >50000 ids'
    );
    await assert.rejects(
      async () => engine.cloneProfiles({ ids: overLimitIds }),
      /Invalid profile selection/,
      'cloneProfiles must reject >50000 ids'
    );

    // 10.2 syncProfiles 100000 boundary
    const overSync = new Array(100001).fill({ id: 'p1' });
    await assert.rejects(
      async () => engine.syncProfiles(overSync),
      /Invalid profile list/,
      'syncProfiles must reject >100000 items'
    );

    console.log('  PASS  50000 and 100000 batch boundary guardrails enforced');

    console.log('\nAll Large Fleet Tests PASSED!');
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (_) {}
  }
}

main().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
