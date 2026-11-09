'use strict';

/**
 * OpenBrowser - Profile Pagination & Summary Projection Test Suite
 *
 * Verifies:
 * 1. 1500 profiles seeded with large fingerprint payloads (canvas, webgl, audio, fonts).
 * 2. SQL-level LIMIT/OFFSET windowing & total accuracy.
 * 3. Summary projection excludes large fingerprint fields (canvas, webgl, etc.).
 * 4. Fuzzy name search (SQL LIKE), group filtering, and ungrouped filtering.
 * 5. Sorting by number (ASC/DESC), name, and createdAt.
 * 6. Recycle bin (trash) pagination & total filtering.
 * 7. Full profile retrieval via existing getProfile() remains intact.
 * 8. Engine queryProfilesPage integration & non-SQLite fallback.
 * 9. Performance benchmark: page query time vs full table decryption.
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const credentialCrypto = require('../credential-crypto');
const { ProfileStoreSqlite } = require('./profile-store-sqlite');

async function runTest() {
  console.log('Running Profile Pagination & Summary Projection Test Suite...\n');

  // Configure high-performance AES-GCM safeStorage mock to simulate Electron safeStorage
  const mockKey = crypto.createHash('sha256').update('openbrowser-pagination-test-master-key').digest();
  credentialCrypto.setSafeStorageMock({
    isEncryptionAvailable: () => true,
    encryptString: (plain) => {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', mockKey, iv);
      const enc = Buffer.concat([cipher.update(Buffer.from(plain, 'utf8')), cipher.final()]);
      const tag = cipher.getAuthTag();
      return Buffer.concat([iv, tag, enc]);
    },
    decryptString: (buf) => {
      const iv = buf.subarray(0, 12);
      const tag = buf.subarray(12, 28);
      const enc = buf.subarray(28);
      const decipher = crypto.createDecipheriv('aes-256-gcm', mockKey, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
    },
  });

  const tmpDir = path.join(os.tmpdir(), `ob-page-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  // A database created before the searchable columns existed must upgrade in place.
  const legacyDbPath = path.join(tmpDir, 'legacy-data.db');
  const { DatabaseSync } = require('node:sqlite');
  const legacyDb = new DatabaseSync(legacyDbPath);
  legacyDb.exec(`
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY, number INTEGER, name TEXT NOT NULL, group_id TEXT,
      trashed INTEGER DEFAULT 0, trashed_at TEXT, created_at TEXT, updated_at TEXT,
      data TEXT NOT NULL
    );
  `);
  legacyDb.prepare('INSERT INTO profiles (id, number, name, data) VALUES (?, ?, ?, ?)')
    .run('legacy-search', 1, 'Legacy', JSON.stringify({ id: 'legacy-search', name: 'Legacy', title: 'Original title' }));
  legacyDb.close();
  const legacyStore = new ProfileStoreSqlite({ dbPath: legacyDbPath, wal: true });
  await legacyStore.init();
  try {
    const upgraded = legacyStore.queryProfilesPage({ filters: { search: 'Original title' } });
    assert.strictEqual(upgraded.rows.length, 1, 'existing SQLite profiles must survive schema upgrade');
  } finally {
    legacyStore.close();
  }

  const dbPath = path.join(tmpDir, 'openbrowser-data.db');
  const store = new ProfileStoreSqlite({ dbPath, wal: true });
  await store.init();

  try {
    // ------------------------------------------------------------------------
    // [1] Seed 1,500 profiles with large fingerprint payloads
    // ------------------------------------------------------------------------
    console.log('--- [Test 1] Seeding 1,500 Profiles with Heavy Fingerprint Objects ---');
    const TOTAL_PROFILES = 1500;
    const TRASHED_COUNT = 100;
    const ACTIVE_COUNT = TOTAL_PROFILES - TRASHED_COUNT; // 1400

    const profiles = [];
    const now = Date.now();

    for (let i = 1; i <= TOTAL_PROFILES; i++) {
      const isTrashed = i <= TRASHED_COUNT;
      let name = `Profile-${i}`;
      if (i === 101) name = 'SpecialTarget Alpha';
      if (i === 202) name = 'SpecialTarget Beta';
      if (i === 303) name = 'Escape_100%_Profile';
      if (i === 304) name = 'EscapeX1000XProfile';

      // Distribute groups among active profiles
      let groupId = null;
      if (i % 3 === 0) groupId = 'group-marketing';
      else if (i % 3 === 1) groupId = 'group-development';

      const createdAt = new Date(now - (TOTAL_PROFILES - i) * 60000).toISOString();
      const updatedAt = new Date(now - (TOTAL_PROFILES - i) * 30000).toISOString();

      profiles.push({
        id: `profile-${i}`,
        number: i,
        name,
        title: `Workspace ${i}`,
        groupId,
        browser: i % 2 === 0 ? 'Chrome/130.0.0.0' : 'Edge/130.0.0.0',
        proxy: i % 4 === 0 ? 'direct' : `socks5://127.0.0.1:${10000 + i}`,
        networkMode: i % 4 === 0 ? 'direct' : 'proxy',
        tag: i % 5 === 0 ? 'VIP' : 'Standard',
        tags: ['e2e', `batch-${Math.floor(i / 100)}`],
        notes: `Automated test profile #${i}`,
        trashed: isTrashed,
        trashedAt: isTrashed ? new Date(now - 10000).toISOString() : null,
        createdAt,
        updatedAt,
        // Large fingerprint object to simulate real-world production footprint
        fingerprint: {
          canvas: 'canvas_noise_signature_'.repeat(150),
          webgl: {
            vendor: 'Google Inc. (Apple)',
            renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Pro, Version 14.5)',
            extensions: Array.from({ length: 60 }, (_, extIdx) => `GL_OES_extension_${extIdx}`),
          },
          audio: {
            dynamicsCompressor: [0.12345, 0.67891, 0.98765],
            buffer: 'audio_channel_buffer_hex_'.repeat(100),
          },
          fonts: Array.from({ length: 120 }, (_, fIdx) => `SystemFont-${fIdx}`),
          clientRects: Array.from({ length: 50 }, (_, rIdx) => ({ x: rIdx, y: rIdx * 2, w: 100, h: 20 })),
          webrtc: { mode: 'replace', localIp: '192.168.1.100', publicIp: '203.0.113.1' },
          speechVoices: Array.from({ length: 30 }, (_, vIdx) => ({ name: `Voice-${vIdx}`, lang: 'en-US' })),
        },
        cookies: JSON.stringify([
          { name: 'session_token', value: 'secret_hex_token_'.repeat(20), domain: '.example.com' },
          { name: 'auth_jwt', value: 'jwt_signature_blob_'.repeat(20), domain: '.example.com' },
        ]),
      });
    }

    const tSeedStart = Date.now();
    store.saveProfiles(profiles);
    const tSeedElapsed = Date.now() - tSeedStart;
    console.log(`  PASS  Seeded ${TOTAL_PROFILES} profiles into SQLite in ${tSeedElapsed}ms`);

    // ------------------------------------------------------------------------
    // [2] SQL-level pagination windowing and total count
    // ------------------------------------------------------------------------
    console.log('\n--- [Test 2] Pagination Window & Total Verification ---');
    // Page 1, pageSize 50
    const p1 = store.queryProfilesPage({ page: 1, pageSize: 50 });
    assert.strictEqual(p1.total, ACTIVE_COUNT, `Total active profiles must be ${ACTIVE_COUNT}`);
    assert.strictEqual(p1.page, 1);
    assert.strictEqual(p1.pageSize, 50);
    assert.strictEqual(p1.rows.length, 50);
    // Number 1..100 are trashed, so the first active profile is number 101
    assert.strictEqual(p1.rows[0].number, 101);
    assert.strictEqual(p1.rows[49].number, 150);
    console.log('  PASS  Page 1 (offset 0, limit 50) correctly returned items 101..150');

    // Page 2, pageSize 50
    const p2 = store.queryProfilesPage({ page: 2, pageSize: 50 });
    assert.strictEqual(p2.page, 2);
    assert.strictEqual(p2.rows.length, 50);
    assert.strictEqual(p2.rows[0].number, 151);
    assert.strictEqual(p2.rows[49].number, 200);
    console.log('  PASS  Page 2 (offset 50, limit 50) correctly returned items 151..200');

    // Last page (1400 / 50 = page 28)
    const pLast = store.queryProfilesPage({ page: 28, pageSize: 50 });
    assert.strictEqual(pLast.page, 28);
    assert.strictEqual(pLast.rows.length, 50);
    assert.strictEqual(pLast.rows[49].number, 1500);
    console.log('  PASS  Last page 28 correctly returned final items ending with number 1500');

    // Out of bounds page
    const pEmpty = store.queryProfilesPage({ page: 29, pageSize: 50 });
    assert.strictEqual(pEmpty.total, ACTIVE_COUNT);
    assert.strictEqual(pEmpty.rows.length, 0);
    console.log('  PASS  Out of bounds page correctly returned empty rows array');

    // ------------------------------------------------------------------------
    // [3] Summary projection: large fingerprint fields strictly excluded
    // ------------------------------------------------------------------------
    console.log('\n--- [Test 3] Summary Projection Field Verification ---');
    for (const row of p1.rows) {
      // Must NOT contain large fingerprint fields
      assert.strictEqual(row.canvas, undefined, 'Summary row must not include canvas');
      assert.strictEqual(row.webgl, undefined, 'Summary row must not include webgl');
      assert.strictEqual(row.audio, undefined, 'Summary row must not include audio');
      assert.strictEqual(row.fonts, undefined, 'Summary row must not include fonts');
      assert.strictEqual(row.clientRects, undefined, 'Summary row must not include clientRects');
      assert.strictEqual(row.fingerprint, undefined, 'Summary row must not include fingerprint');
      assert.strictEqual(row.cookies, undefined, 'Summary row must not include cookies');

      // Must contain essential lightweight fields
      assert.ok(row.id, 'Row must have id');
      assert.ok(typeof row.number === 'number', 'Row must have numeric number');
      assert.ok(row.name, 'Row must have name');
      assert.ok(row.browser, 'Row must have browser');
      assert.ok(row.proxy, 'Row must have proxy');
      assert.ok(row.createdAt, 'Row must have createdAt');
      assert.strictEqual(row.trashed, false, 'Active row must have trashed=false');
      assert.strictEqual(row._isSummaryProjection, true, 'Row must declare _isSummaryProjection');
      assert.strictEqual(typeof row.note, 'string', 'Row must expose note string');
      assert.strictEqual(typeof row.notes, 'string', 'Row must expose notes string');
    }
    console.log('  PASS  Summary projection strictly omits fingerprint/cookie blobs');
    console.log('  PASS  Essential UI fields (id, number, name, browser, proxy, dates) are intact');

    // ------------------------------------------------------------------------
    // [4] Filter verification (name LIKE, groupId, ungrouped)
    // ------------------------------------------------------------------------
    console.log('\n--- [Test 4] Filter Verification ---');
    // Name fuzzy search
    const searchRes = store.queryProfilesPage({ filters: { name: 'SpecialTarget' } });
    assert.strictEqual(searchRes.total, 2, 'Search for SpecialTarget must match exactly 2 rows');
    assert.strictEqual(searchRes.rows.length, 2);
    assert.deepStrictEqual(
      searchRes.rows.map((r) => r.name),
      ['SpecialTarget Alpha', 'SpecialTarget Beta']
    );
    console.log('  PASS  Fuzzy name search (SQL LIKE) found matching profiles');

    // Title search
    const searchTitleRes = store.queryProfilesPage({ filters: { query: 'Workspace 202' } });
    assert.strictEqual(searchTitleRes.total, 1, 'Search for Workspace 202 must match 1 row');
    assert.strictEqual(searchTitleRes.rows[0].title, 'Workspace 202');
    console.log('  PASS  Title search (SQL LIKE) found matching profile');

    // Tag search
    const searchTagRes = store.queryProfilesPage({ filters: { query: 'VIP' }, pageSize: 10 });
    assert.ok(searchTagRes.total > 0, 'Search for VIP tag must return profiles');
    for (const r of searchTagRes.rows) {
      assert.strictEqual(r.tag, 'VIP');
    }
    console.log(`  PASS  Tag search returned ${searchTagRes.total} items with tag VIP`);

    // LIKE escaping test for % and _
    const esc1 = store.queryProfilesPage({ filters: { name: '100%' } });
    assert.strictEqual(esc1.total, 1, 'Search for 100% must literally match only Escape_100%_Profile');
    assert.strictEqual(esc1.rows[0].name, 'Escape_100%_Profile');

    const esc2 = store.queryProfilesPage({ filters: { name: 'Escape_' } });
    assert.strictEqual(esc2.total, 1, 'Search for Escape_ must literally match only Escape_100%_Profile');
    assert.strictEqual(esc2.rows[0].name, 'Escape_100%_Profile');
    console.log('  PASS  Fuzzy name search correctly escapes LIKE wildcards (% and _)');

    // GroupId filter
    const groupRes = store.queryProfilesPage({ filters: { groupId: 'group-marketing' }, pageSize: 100 });
    assert.ok(groupRes.total > 0, 'Must have marketing group profiles');
    for (const r of groupRes.rows) {
      assert.strictEqual(r.groupId, 'group-marketing');
    }
    console.log(`  PASS  GroupId filter returned ${groupRes.total} items with correct groupId`);

    // Ungrouped filter with 'ungrouped'
    const ungroupedRes = store.queryProfilesPage({ filters: { groupId: 'ungrouped' }, pageSize: 100 });
    assert.ok(ungroupedRes.total > 0, 'Must have ungrouped profiles');
    for (const r of ungroupedRes.rows) {
      assert.strictEqual(r.groupId, null);
    }
    console.log(`  PASS  Ungrouped filter returned ${ungroupedRes.total} items without groupId`);

    // Ungrouped filter with empty string groupId: ''
    const emptyGroupIdRes = store.queryProfilesPage({ filters: { groupId: '' }, pageSize: 100 });
    assert.strictEqual(emptyGroupIdRes.total, ungroupedRes.total, 'filters.groupId: "" must yield identical total to "ungrouped"');
    for (const r of emptyGroupIdRes.rows) {
      assert.strictEqual(r.groupId, null);
    }
    console.log(`  PASS  groupId: "" filter correctly resolved to ungrouped profiles (${emptyGroupIdRes.total} items)`);

    // ------------------------------------------------------------------------
    // [5] Sorting verification
    // ------------------------------------------------------------------------
    console.log('\n--- [Test 5] Sort Order Verification ---');
    // Sort number DESC
    const sortDesc = store.queryProfilesPage({ page: 1, pageSize: 10, sort: 'number DESC' });
    assert.strictEqual(sortDesc.rows[0].number, 1500);
    assert.strictEqual(sortDesc.rows[1].number, 1499);
    console.log('  PASS  sort "number DESC" returns descending numbers starting at 1500');

    // Sort name ASC
    const sortName = store.queryProfilesPage({ page: 1, pageSize: 10, sort: 'name ASC' });
    assert.ok(sortName.rows[0].name <= sortName.rows[1].name);
    console.log('  PASS  sort "name ASC" returns alphabetical profile names');

    // Sort createdAt DESC
    const sortCreated = store.queryProfilesPage({ page: 1, pageSize: 10, sort: 'createdAt DESC' });
    assert.ok(sortCreated.rows[0].createdAt >= sortCreated.rows[1].createdAt);
    console.log('  PASS  sort "createdAt DESC" returns latest profiles first');

    // ------------------------------------------------------------------------
    // [6] Recycle Bin (Trash) Pagination & View Isolation
    // ------------------------------------------------------------------------
    console.log('\n--- [Test 6] Recycle Bin (Trash) Pagination Verification ---');
    const trashP1 = store.queryProfilesPage({ page: 1, pageSize: 50, filters: { trashed: true } });
    assert.strictEqual(trashP1.total, TRASHED_COUNT, `Trash total must equal ${TRASHED_COUNT}`);
    assert.strictEqual(trashP1.rows.length, 50);
    for (const r of trashP1.rows) {
      assert.strictEqual(r.trashed, true);
    }

    const trashP2 = store.queryProfilesPage({ page: 2, pageSize: 50, filters: { activeGroupFilter: 'trash' } });
    assert.strictEqual(trashP2.rows.length, 50);
    for (const r of trashP2.rows) {
      assert.strictEqual(r.trashed, true);
    }

    const trashP3 = store.queryProfilesPage({ page: 3, pageSize: 50, filters: { trashed: true } });
    assert.strictEqual(trashP3.rows.length, 0);
    console.log('  PASS  Recycle Bin correctly paginated 100 trashed items (50 + 50)');

    // ------------------------------------------------------------------------
    // [7] Full Profile Retrieval via getProfile() Remains Intact
    // ------------------------------------------------------------------------
    console.log('\n--- [Test 7] Full Profile Retrieval Parity ---');
    const fullProfile = store.getProfile('profile-101');
    assert.ok(fullProfile, 'Profile 101 must exist');
    assert.ok(fullProfile.fingerprint, 'Full profile must retain fingerprint');
    assert.ok(fullProfile.fingerprint.canvas.length > 1000, 'Full canvas signature must be intact');
    assert.strictEqual(fullProfile.fingerprint.webgl.extensions.length, 60);
    assert.strictEqual(fullProfile.fingerprint.fonts.length, 120);
    assert.ok(fullProfile.cookies, 'Cookies must be intact in full profile');
    console.log('  PASS  store.getProfile() accurately retrieves full fingerprint & credential data');

    // ------------------------------------------------------------------------
    // [8] Real BrowserEngine Integration & Fallback Verification
    // ------------------------------------------------------------------------
    console.log('\n--- [Test 8] Real BrowserEngine Integration & Fallback ---');
    const { BrowserEngine } = require('../engine');
    const engineApp = { getPath: () => tmpDir };
    const engine = new BrowserEngine(engineApp, {
      profileDataRoot: path.join(tmpDir, 'engine-data-root'),
      dbPath,
      auditLogs: false,
    });
    engine.usingSqlite = true;
    engine.sqliteStore = store;
    engine.running.set('profile-101', {
      port: 9222,
      pid: 12345,
      browser: { name: 'Google Chrome', path: '/mock/chrome' },
      extensions: [],
    });
    engine.networkInfo.set('profile-101', { ip: '1.2.3.4', countryCode: 'US' });
    engine.assignments.set('profile-101', new Set(['ext-adblock']));

    // Real BrowserEngine delegation
    const enginePage = engine.queryProfilesPage({ page: 1, pageSize: 10 });
    assert.strictEqual(enginePage.rows.length, 10);
    const row101 = enginePage.rows.find((r) => r.id === 'profile-101');
    assert.ok(row101, 'profile-101 must be in rows');
    assert.strictEqual(row101.running, true);
    assert.strictEqual(row101.port, 9222);
    assert.strictEqual(row101.network?.countryCode, 'US');
    assert.deepStrictEqual(row101.assignedExtensions, ['ext-adblock']);
    console.log('  PASS  Real BrowserEngine properly delegates to sqliteStore and enriches status');

    // Real BrowserEngine getProfile retrieves full decrypted data
    const engineGetProfile = engine.getProfile('profile-101');
    assert.ok(engineGetProfile, 'engine.getProfile must find profile-101');
    assert.ok(engineGetProfile.fingerprint, 'engine.getProfile must retain full fingerprint');
    assert.ok(engineGetProfile.fingerprint.canvas.length > 1000);
    console.log('  PASS  Real BrowserEngine getProfile retrieves full fingerprint data');

    // Real BrowserEngine non-SQLite fallback
    const legacyApp = { getPath: () => path.join(tmpDir, 'legacy') };
    const legacyEngine = new BrowserEngine(legacyApp, {
      profileDataRoot: path.join(tmpDir, 'legacy-data-root'),
      auditLogs: false,
    });
    legacyEngine.usingSqlite = false;
    legacyEngine.sqliteStore = null;
    legacyEngine.profiles.clear();
    for (let m = 1; m <= 30; m++) {
      legacyEngine.profiles.set(`legacy-${m}`, {
        id: `legacy-${m}`,
        number: m,
        name: `LegacyProfile-${m}`,
        groupId: m % 2 === 0 ? 'group-even' : 'group-odd',
        browser: 'Google Chrome',
        proxy: 'direct',
        trashed: m > 20,
        createdAt: new Date(now - m * 1000).toISOString(),
        fingerprint: { canvas: 'legacy_canvas_noise_'.repeat(100) },
      });
    }

    const legacyP1 = legacyEngine.queryProfilesPage({ page: 1, pageSize: 5 });
    assert.strictEqual(legacyP1.total, 20, '20 active profiles in legacy engine');
    assert.strictEqual(legacyP1.rows.length, 5);
    assert.strictEqual(legacyP1.rows[0].canvas, undefined, 'Legacy fallback projection must omit canvas');
    assert.strictEqual(legacyP1.rows[0].number, 1);

    const legacyTrash = legacyEngine.queryProfilesPage({ page: 1, pageSize: 10, filters: { trashed: true } });
    assert.strictEqual(legacyTrash.total, 10, '10 trashed profiles in legacy engine');
    assert.strictEqual(legacyTrash.rows.length, 10);

    const legacySearch = legacyEngine.queryProfilesPage({ filters: { name: 'LegacyProfile-7' } });
    assert.strictEqual(legacySearch.total, 1);
    assert.strictEqual(legacySearch.rows[0].id, 'legacy-7');
    console.log('  PASS  Real BrowserEngine non-SQLite fallback operates identically with pagination & projection');

    // ------------------------------------------------------------------------
    // [9] Performance Benchmark (Pagination vs Full-Table Scan)
    // ------------------------------------------------------------------------
    console.log('\n--- [Test 9] Performance Benchmark (1,500 Profiles) ---');
    // Measure paginated query (page size 50)
    const iters = 20;
    const tPageStart = process.hrtime.bigint();
    for (let k = 0; k < iters; k++) {
      store.queryProfilesPage({ page: (k % 5) + 1, pageSize: 50 });
    }
    const tPageEnd = process.hrtime.bigint();
    const avgPageMs = Number(tPageEnd - tPageStart) / (iters * 1e6);

    // Measure full table scan (old model)
    const tFullStart = process.hrtime.bigint();
    const allProfiles = store.getAllProfiles();
    const tFullEnd = process.hrtime.bigint();
    const fullMs = Number(tFullEnd - tFullStart) / 1e6;

    console.log(`  BENCHMARK: queryProfilesPage (50 rows) avg: ${avgPageMs.toFixed(2)} ms`);
    console.log(`  BENCHMARK: getAllProfiles (1500 full rows):  ${fullMs.toFixed(2)} ms`);
    console.log(`  SPEEDUP:   ${(fullMs / avgPageMs).toFixed(1)}x faster response time`);
    assert.ok(avgPageMs < 50 && avgPageMs < fullMs / 2,
      `Page query should be >2x faster than full scan and < 50ms (got avg=${avgPageMs.toFixed(2)}ms, full=${fullMs.toFixed(2)}ms)`);

    // ------------------------------------------------------------------------
    // [10] Backend Aggregation Counts, Number Allocation & Corrupted Projection
    // ------------------------------------------------------------------------
    console.log('\n--- [Test 10] Backend Aggregation Counts & Corrupted Projection ---');
    const counts = store.getProfileCounts();
    assert.strictEqual(counts.total, TOTAL_PROFILES, `Total profiles count must equal ${TOTAL_PROFILES}`);
    assert.strictEqual(counts.trashed, TRASHED_COUNT, `Trashed count must equal ${TRASHED_COUNT}`);
    assert.strictEqual(counts.active, ACTIVE_COUNT, `Active count must equal ${ACTIVE_COUNT}`);
    const sumActiveGroups = counts.ungrouped + (counts.byGroup['group-marketing'] || 0) + (counts.byGroup['group-development'] || 0);
    assert.strictEqual(sumActiveGroups, ACTIVE_COUNT, 'Sum of active groups must equal active count');
    assert.deepStrictEqual(p1.counts, counts, 'queryProfilesPage must attach identical counts object');
    console.log('  PASS  getProfileCounts() accurately aggregated active, trashed, ungrouped, and groups');

    const nextNum = store.getNextProfileNumber();
    assert.strictEqual(nextNum, TOTAL_PROFILES + 1, `Next number must be ${TOTAL_PROFILES + 1}`);
    console.log(`  PASS  getNextProfileNumber() correctly returned ${nextNum}`);

    // Insert corrupted row into profiles table to test corrupt projection
    store.db.prepare(
      'INSERT INTO profiles (id, number, name, title, tag, proxy_text, group_id, trashed, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);'
    ).run('corrupt-profile-99', 9999, 'Corrupted Profile', 'Corrupt Title', 'BadTag', 'direct', null, 0, 'bad_non_json_corrupted_cipher_blob');

    const corruptPage = store.queryProfilesPage({ filters: { id: 'corrupt-profile-99' } });
    assert.strictEqual(corruptPage.rows.length, 1, 'Corrupted row should be retrieved');
    const cRow = corruptPage.rows[0];
    assert.strictEqual(cRow.corrupted, true, 'Corrupted row must have corrupted: true');
    assert.strictEqual(cRow.networkMode, 'corrupted', 'Corrupted row must not disguise networkMode as direct');
    assert.strictEqual(cRow.proxy, '', 'Corrupted row proxy must be empty string (not direct)');
    assert.strictEqual(cRow._isSummaryProjection, true, 'Corrupted row must declare _isSummaryProjection');
    console.log('  PASS  Corrupted payload projected with corrupted: true, networkMode: "corrupted", proxy: ""');

    // A failed encryption operation must never silently write a plaintext profile.
    const encryptCredential = credentialCrypto.encryptCredential;
    try {
      credentialCrypto.encryptCredential = () => { throw new Error('simulated encryption failure'); };
      assert.throws(() => store.saveProfiles([{
        id: 'encryption-failure-test', number: 20000, name: 'Encryption failure',
        proxy: 'socks5://test-user:test-password@example.test:1080',
      }]), /simulated encryption failure/);
      const row = store.db.prepare('SELECT data FROM profiles WHERE id = ?').get('encryption-failure-test');
      assert.strictEqual(row, undefined, 'failed encryption must not write a plaintext row');
    } finally {
      credentialCrypto.encryptCredential = encryptCredential;
    }
    console.log('  PASS  Encryption failure aborts profile writes instead of storing plaintext');

    const secret = 'search-index-password';
    store.saveProfiles([{
      id: 'proxy-index-test', number: 20001, name: 'Proxy index test',
      proxy: `127.0.0.1:1080:test-user:${secret}`,
    }]);
    let indexed = store.db.prepare('SELECT proxy_text FROM profiles WHERE id = ?').get('proxy-index-test');
    assert.ok(!indexed.proxy_text.includes(secret), 'search metadata must not contain proxy credentials');
    // Simulate a pre-fix index and verify that reopening rebuilds it without secrets.
    store.db.prepare('UPDATE profiles SET proxy_text = ? WHERE id = ?').run(secret, 'proxy-index-test');
    store.db.prepare('DELETE FROM meta WHERE key = ?').run('profile_search_index_version');
    store.close();
    await store.init();
    indexed = store.db.prepare('SELECT proxy_text FROM profiles WHERE id = ?').get('proxy-index-test');
    assert.ok(!indexed.proxy_text.includes(secret), 'reopening must scrub old plaintext search metadata');
    console.log('  PASS  Proxy search metadata excludes credentials and repairs an existing index');

    console.log('\n======================================================');
    console.log('ALL PROFILE PAGINATION & PROJECTION TESTS PASSED!');
    console.log('======================================================');
  } finally {
    credentialCrypto.setSafeStorageMock(null);
    store.close();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) {}
  }
}

runTest().catch((err) => {
  console.error('\nFAIL:', err);
  process.exit(1);
});
