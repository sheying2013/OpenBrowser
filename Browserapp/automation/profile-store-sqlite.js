'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const {
  readEngineStateCandidate,
  engineStateRecoveryCandidates,
} = require('../engine/state-storage');
// profiles.data 含代理凭据/Cookies，落库前整体加密（与 state-storage 同一套 credential-crypto），读路径兼容明文
const credentialCrypto = require('../credential-crypto');

function sanitizeProxyText(proxy) {
  if (!proxy) return '';
  if (typeof proxy === 'string' && /^(direct|offline|none)$/i.test(proxy.trim())) return 'direct';
  try {
    const { parseProxy } = require('../proxy-forwarder');
    const parsed = parseProxy(proxy);
    if (!parsed?.host || !parsed.port) return '';
    const host = parsed.host.includes(':') ? `[${parsed.host.replace(/^\[|\]$/g, '')}]` : parsed.host;
    return `${parsed.protocol}://${host}:${parsed.port}`;
  } catch (_) {
    // Never index an unrecognized proxy string: it may contain credentials.
    return '';
  }
}

function encodeProfileData(profile) {
  return credentialCrypto.encryptCredential(JSON.stringify(profile));
}

function decodeProfileData(text) {
  try {
    // node:sqlite 对 BLOB 读回 Uint8Array（非 Buffer），必须归一后才能识别加密头
    const raw = (text instanceof Uint8Array && !Buffer.isBuffer(text)) ? Buffer.from(text) : text;
    if (credentialCrypto.isEncrypted(raw)) {
      return JSON.parse(credentialCrypto.decryptCredential(raw));
    }
    return typeof raw === 'string' ? JSON.parse(raw) : JSON.parse(Buffer.from(raw).toString('utf8'));
  } catch (_) {
    return null;
  }
}

class ProfileStoreSqlite {
  /**
   * @param {Object} options
   * @param {string} options.dbPath Path to openbrowser-data.db
   * @param {string} [options.legacyJsonPath] Path to openbrowser-engine.json
   * @param {boolean} [options.wal=true] Enable WAL journal mode
   * @param {boolean} [options.backupOldJson=true] Rename legacy json to .migrated.bak on success
   */
  constructor(options = {}) {
    if (!options.dbPath) {
      throw new Error('dbPath is required for ProfileStoreSqlite');
    }
    this.dbPath = path.resolve(options.dbPath);
    this.profileDataRoot = options.profileDataRoot ? path.resolve(options.profileDataRoot) : null;
    this.legacyJsonPath = options.legacyJsonPath ? path.resolve(options.legacyJsonPath) : null;
    this.enableWal = options.wal !== false;
    this.backupOldJson = options.backupOldJson !== false;
    this.db = null;
    this.isOpen = false;
    this._statements = {};
  }

  /**
   * Check whether node:sqlite is supported in the current runtime.
   * @returns {boolean}
   */
  static isSupported() {
    try {
      const sqlite = require('node:sqlite');
      return typeof sqlite?.DatabaseSync === 'function';
    } catch (_) {
      return false;
    }
  }

  /**
   * Check whether migration is needed.
   * Migration is needed if:
   * 1. dbPath does not exist (or has 0 bytes), AND
   * 2. legacyJsonPath exists and is readable.
   */
  needsMigration() {
    if (!this.legacyJsonPath) return false;
    const dbExists = fs.existsSync(this.dbPath) && fs.statSync(this.dbPath).size > 0;
    if (dbExists) return false;
    return fs.existsSync(this.legacyJsonPath);
  }

  /**
   * Initialize the SQLite store, performing migration from legacy JSON if needed.
   * Returns an object { migrated: boolean, error?: Error }.
   */
  async init() {
    if (this.isOpen && this.db) return { migrated: false };

    let migrated = false;
    const dbDir = path.dirname(this.dbPath);
    fs.mkdirSync(dbDir, { recursive: true });

    if (this.needsMigration()) {
      try {
        await this._performMigration();
        migrated = true;
      } catch (err) {
        // Safe rollback: clean up partial db files and re-throw so engine falls back to JSON
        this.close();
        this._removeDbFiles();
        throw new Error(`SQLite migration failed; safely reverting to legacy JSON: ${err.message}`);
      }
    }

    if (!this.isOpen) {
      this._openDatabase();
      this._createSchema();
      this._prepareStatements();
    }

    return { migrated };
  }

  _openDatabase() {
    this.db = new DatabaseSync(this.dbPath);
    if (this.enableWal) {
      this.db.exec('PRAGMA journal_mode = WAL;');
      this.db.exec('PRAGMA synchronous = NORMAL;');
    }
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.isOpen = true;
  }

  _createSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS groups (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        color TEXT,
        note TEXT,
        sort INTEGER DEFAULT 0,
        created_at TEXT,
        data TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS profiles (
        id TEXT PRIMARY KEY,
        number INTEGER,
        name TEXT NOT NULL,
        title TEXT,
        tag TEXT,
        proxy_text TEXT,
        group_id TEXT,
        trashed INTEGER DEFAULT 0,
        trashed_at TEXT,
        created_at TEXT,
        updated_at TEXT,
        data TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_profiles_trashed ON profiles(trashed);
      CREATE INDEX IF NOT EXISTS idx_profiles_group_id ON profiles(group_id);
      CREATE INDEX IF NOT EXISTS idx_profiles_number ON profiles(number);
      CREATE INDEX IF NOT EXISTS idx_profiles_name ON profiles(name);
      CREATE INDEX IF NOT EXISTS idx_groups_sort ON groups(sort);

      CREATE TABLE IF NOT EXISTS extensions (
        id TEXT PRIMARY KEY,
        name TEXT,
        version TEXT,
        path TEXT,
        built_in INTEGER DEFAULT 0,
        added_at TEXT,
        data TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS extension_assignments (
        profile_id TEXT NOT NULL,
        extension_id TEXT NOT NULL,
        PRIMARY KEY (profile_id, extension_id)
      );

      CREATE INDEX IF NOT EXISTS idx_ext_assign_profile ON extension_assignments(profile_id);
      CREATE INDEX IF NOT EXISTS idx_ext_assign_ext ON extension_assignments(extension_id);
    `);

    // Add columns before indexing them so existing databases can be upgraded.
    const tableInfo = this.db.prepare('PRAGMA table_info(profiles);').all();
    const colNames = new Set(tableInfo.map((c) => c.name));
    if (!colNames.has('title')) {
      this.db.exec('ALTER TABLE profiles ADD COLUMN title TEXT;');
    }
    if (!colNames.has('tag')) {
      this.db.exec('ALTER TABLE profiles ADD COLUMN tag TEXT;');
    }
    if (!colNames.has('proxy_text')) {
      this.db.exec('ALTER TABLE profiles ADD COLUMN proxy_text TEXT;');
    }

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_profiles_title ON profiles(title);
      CREATE INDEX IF NOT EXISTS idx_profiles_tag ON profiles(tag);
      CREATE INDEX IF NOT EXISTS idx_profiles_proxy_text ON profiles(proxy_text);
    `);

    // Rebuild legacy search metadata once, including potentially unsafe older values.
    try {
      const needsBackfill = !this.db.prepare(
        "SELECT value FROM meta WHERE key = 'profile_search_index_version';"
      ).get();
      if (needsBackfill) {
        const missingRows = this.db.prepare(
          'SELECT id, data FROM profiles WHERE data IS NOT NULL;'
        ).all();
        const updateStmt = this.db.prepare(
          'UPDATE profiles SET title = ?, tag = ?, proxy_text = ? WHERE id = ?;'
        );
        this.db.exec('BEGIN TRANSACTION;');
        try {
          for (const row of missingRows) {
            const decoded = decodeProfileData(row.data);
            const title = decoded ? String(decoded.title || '') : '';
            const tag = decoded ? String(decoded.tag || (Array.isArray(decoded.tags) && decoded.tags[0]) || '') : '';
            const proxyText = decoded ? sanitizeProxyText(decoded.proxy) : '';
            updateStmt.run(title, tag, proxyText, String(row.id));
          }
          this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
            .run('profile_search_index_version', '2');
          this.db.exec('COMMIT;');
        } catch (error) {
          try { this.db.exec('ROLLBACK;'); } catch (_) {}
          throw error;
        }
      }
    } catch (error) {
      throw new Error(`Failed to backfill profile search columns: ${error.message}`, { cause: error });
    }
  }

  _prepareStatements() {
    this._statements = {
      // Profile statements
      upsertProfile: this.db.prepare(`
        INSERT INTO profiles (id, number, name, title, tag, proxy_text, group_id, trashed, trashed_at, created_at, updated_at, data)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          number = excluded.number,
          name = excluded.name,
          title = excluded.title,
          tag = excluded.tag,
          proxy_text = excluded.proxy_text,
          group_id = excluded.group_id,
          trashed = excluded.trashed,
          trashed_at = excluded.trashed_at,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          data = excluded.data;
      `),
      getProfile: this.db.prepare('SELECT data FROM profiles WHERE id = ?'),
      getAllProfiles: this.db.prepare('SELECT data FROM profiles ORDER BY number ASC, id ASC'),
      getProfileCount: this.db.prepare('SELECT count(*) as count FROM profiles'),
      deleteProfile: this.db.prepare('DELETE FROM profiles WHERE id = ?'),
      updateProfileTrash: this.db.prepare(`
        UPDATE profiles SET trashed = ?, trashed_at = ?, updated_at = ?, data = ? WHERE id = ?
      `),
      getTrashedProfileIds: this.db.prepare('SELECT id FROM profiles WHERE trashed = 1'),

      // Group statements
      upsertGroup: this.db.prepare(`
        INSERT INTO groups (id, name, color, note, sort, created_at, data)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          color = excluded.color,
          note = excluded.note,
          sort = excluded.sort,
          created_at = excluded.created_at,
          data = excluded.data;
      `),
      getGroup: this.db.prepare('SELECT data FROM groups WHERE id = ?'),
      getAllGroups: this.db.prepare('SELECT data FROM groups ORDER BY sort ASC, name ASC'),
      deleteGroup: this.db.prepare('DELETE FROM groups WHERE id = ?'),

      // Extension statements
      upsertExtension: this.db.prepare(`
        INSERT INTO extensions (id, name, version, path, built_in, added_at, data)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          version = excluded.version,
          path = excluded.path,
          built_in = excluded.built_in,
          added_at = excluded.added_at,
          data = excluded.data;
      `),
      getAllExtensions: this.db.prepare('SELECT data FROM extensions'),
      deleteExtension: this.db.prepare('DELETE FROM extensions WHERE id = ?'),

      // Extension assignment statements
      addAssignment: this.db.prepare(`
        INSERT OR IGNORE INTO extension_assignments (profile_id, extension_id) VALUES (?, ?)
      `),
      removeAssignment: this.db.prepare(`
        DELETE FROM extension_assignments WHERE profile_id = ? AND extension_id = ?
      `),
      clearAssignmentsForProfile: this.db.prepare(`
        DELETE FROM extension_assignments WHERE profile_id = ?
      `),
      clearAssignmentsForExtension: this.db.prepare(`
        DELETE FROM extension_assignments WHERE extension_id = ?
      `),
      getAllAssignments: this.db.prepare('SELECT profile_id, extension_id FROM extension_assignments'),

      // Meta statements
      getMeta: this.db.prepare('SELECT value FROM meta WHERE key = ?'),
      setMeta: this.db.prepare(`
        INSERT INTO meta (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `),
      getAllMeta: this.db.prepare('SELECT key, value FROM meta'),
    };
  }

  async _performMigration() {
    let state = null;
    let readError = null;
    try {
      state = await readEngineStateCandidate(this.legacyJsonPath);
    } catch (err) {
      readError = err;
    }

    if (!state) {
      const candidates = await engineStateRecoveryCandidates(this.legacyJsonPath);
      if (candidates.length) {
        state = candidates[0];
      }
    }

    if (!state) {
      if (readError && readError.code !== 'ENOENT') {
        throw new Error(`Failed to read legacy state during migration: ${readError.message}`);
      }
      return;
    }

    const saved = state.saved || {};
    this._openDatabase();
    this._createSchema();
    this._prepareStatements();

    // Perform migration inside an atomic transaction
    this.db.exec('BEGIN TRANSACTION;');
    try {
      // 1. Profiles
      const profiles = Array.isArray(saved.profiles) ? saved.profiles : [];
      for (const profile of profiles) {
        if (!profile || typeof profile !== 'object' || !profile.id) continue;
        const number = Number.isInteger(profile.number) ? profile.number : (Number(profile.number) || null);
        const name = String(profile.name || profile.id);
        const title = String(profile.title || '');
        const tag = String(profile.tag || (Array.isArray(profile.tags) && profile.tags[0]) || '');
        const proxyText = sanitizeProxyText(profile.proxy);
        const groupId = profile.groupId != null ? String(profile.groupId) : null;
        const trashed = profile.trashed ? 1 : 0;
        const trashedAt = profile.trashedAt ? String(profile.trashedAt) : null;
        const createdAt = profile.createdAt ? String(profile.createdAt) : new Date().toISOString();
        const updatedAt = profile.updatedAt ? String(profile.updatedAt) : new Date().toISOString();
        const data = encodeProfileData(profile);

        this._statements.upsertProfile.run(
          String(profile.id),
          number,
          name,
          title,
          tag,
          proxyText,
          groupId,
          trashed,
          trashedAt,
          createdAt,
          updatedAt,
          data
        );
      }

      // 2. Groups (if present in saved state)
      const groups = Array.isArray(saved.groups) ? saved.groups : [];
      for (const group of groups) {
        if (!group || typeof group !== 'object' || !group.id) continue;
        this._statements.upsertGroup.run(
          String(group.id),
          String(group.name || ''),
          group.color || null,
          group.note || null,
          Number(group.sort) || 0,
          group.createdAt || new Date().toISOString(),
          JSON.stringify(group)
        );
      }

      // 3. Extensions
      const extensions = Array.isArray(saved.extensions) ? saved.extensions : [];
      for (const ext of extensions) {
        if (!ext || typeof ext !== 'object' || !ext.id) continue;
        this._statements.upsertExtension.run(
          String(ext.id),
          String(ext.name || ''),
          String(ext.version || ''),
          String(ext.path || ''),
          ext.builtIn ? 1 : 0,
          ext.addedAt || null,
          JSON.stringify(ext)
        );
      }

      // 4. Assignments
      const assignments = saved.assignments || {};
      for (const [profileId, extIds] of Object.entries(assignments)) {
        if (!Array.isArray(extIds)) continue;
        for (const extId of extIds) {
          this._statements.addAssignment.run(String(profileId), String(extId));
        }
      }

      // 5. Metadata & Settings
      if (saved.kernelPolicyVersion != null) {
        this._statements.setMeta.run('kernelPolicyVersion', JSON.stringify(saved.kernelPolicyVersion));
      }
      if (typeof saved.preferIndependentKernel === 'boolean') {
        this._statements.setMeta.run('preferIndependentKernel', JSON.stringify(saved.preferIndependentKernel));
      }
      if (typeof saved.allowSystemBrowserFallback === 'boolean') {
        this._statements.setMeta.run('allowSystemBrowserFallback', JSON.stringify(saved.allowSystemBrowserFallback));
      }
      if (saved.systemBrowserPath != null) {
        this._statements.setMeta.run('systemBrowserPath', JSON.stringify(saved.systemBrowserPath));
      }
      this._statements.setMeta.run('migrated_at', JSON.stringify(new Date().toISOString()));
      this._statements.setMeta.run('migrated_from', JSON.stringify(this.legacyJsonPath));

      this.db.exec('COMMIT;');
    } catch (err) {
      try { this.db.exec('ROLLBACK;'); } catch (_) {}
      throw err;
    }

    // Integrity check
    const countRow = this._statements.getProfileCount.get();
    const insertedCount = Number(countRow?.count || 0);
    const expectedCount = (Array.isArray(saved.profiles) ? saved.profiles : []).filter(p => p && p.id).length;
    if (insertedCount !== expectedCount) {
      throw new Error(`Profile count mismatch after migration: inserted ${insertedCount}, expected ${expectedCount}`);
    }

    // Rename legacy JSON to .migrated-<timestamp>.bak
    if (this.backupOldJson && fs.existsSync(this.legacyJsonPath)) {
      const backupPath = `${this.legacyJsonPath}.migrated-${Date.now()}.bak`;
      try {
        fs.renameSync(this.legacyJsonPath, backupPath);
      } catch (renameErr) {
        console.warn(`Could not rename legacy JSON file to ${backupPath}: ${renameErr.message}`);
      }
    }
  }

  _removeDbFiles() {
    try { fs.rmSync(this.dbPath, { force: true }); } catch (_) {}
    try { fs.rmSync(`${this.dbPath}-wal`, { force: true }); } catch (_) {}
    try { fs.rmSync(`${this.dbPath}-shm`, { force: true }); } catch (_) {}
  }

  close() {
    if (this.db) {
      // Windows 下 WAL 的 -shm 映射在 close 后才释放，先 checkpoint 再关闭，确保临时目录可清理
      try {
        this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
      } catch (_) {}
      try {
        this.db.close();
      } catch (_) {}
      this.db = null;
    }
    this.isOpen = false;
    this._statements = {};
  }

  /* ---------------- Profile operations ---------------- */

  saveProfile(profile) {
    if (!profile || typeof profile !== 'object' || !profile.id) {
      throw new Error('Invalid profile data');
    }
    const id = String(profile.id);
    const number = Number.isInteger(profile.number) ? profile.number : (Number(profile.number) || null);
    const name = String(profile.name || id);
    const title = String(profile.title || '');
    const tag = String(profile.tag || (Array.isArray(profile.tags) && profile.tags[0]) || '');
    const proxyText = sanitizeProxyText(profile.proxy);
    const groupId = profile.groupId != null ? String(profile.groupId) : null;
    const trashed = profile.trashed ? 1 : 0;
    const trashedAt = profile.trashedAt ? String(profile.trashedAt) : null;
    const createdAt = profile.createdAt ? String(profile.createdAt) : new Date().toISOString();
    const updatedAt = profile.updatedAt ? String(profile.updatedAt) : new Date().toISOString();
    const data = encodeProfileData(profile);

    this._statements.upsertProfile.run(
      id,
      number,
      name,
      title,
      tag,
      proxyText,
      groupId,
      trashed,
      trashedAt,
      createdAt,
      updatedAt,
      data
    );
  }

  saveProfiles(profiles, assignments = null) {
    if (!Array.isArray(profiles)) return;
    this.db.exec('BEGIN TRANSACTION;');
    try {
      for (const profile of profiles) {
        if (!profile || typeof profile !== 'object' || !profile.id) continue;
        this.saveProfile(profile);
      }
      if (assignments) {
        for (const [profileId, extensionIds] of assignments) {
          this._statements.clearAssignmentsForProfile.run(String(profileId));
          for (const extensionId of extensionIds) {
            this._statements.addAssignment.run(String(profileId), String(extensionId));
          }
        }
      }
      this.db.exec('COMMIT;');
    } catch (err) {
      try { this.db.exec('ROLLBACK;'); } catch (_) {}
      throw err;
    }
  }

  getProfile(id) {
    const row = this._statements.getProfile.get(String(id));
    if (!row || !row.data) return null;
    return decodeProfileData(row.data);
  }

  getAllProfiles() {
    const rows = this._statements.getAllProfiles.all();
    const result = [];
    for (const row of rows) {
      const decoded = decodeProfileData(row.data);
      if (decoded) result.push(decoded);
    }
    return result;
  }

  /**
   * SQL-level paginated query with lightweight summary projection.
   * Decrypts only the current page slice rather than the entire table.
   *
   * @param {Object} [options]
   * @param {number} [options.page=1]
   * @param {number} [options.pageSize=50]
   * @param {Object} [options.filters]
   * @param {string|Object} [options.sort='number ASC']
   * @returns {{ total: number, page: number, pageSize: number, rows: Array<Object>, counts: Object }}
   */
  queryProfilesPage(options = {}) {
    if (!this.db || !this.isOpen) {
      throw new Error('Database is not open');
    }

    const page = Math.max(1, Number.parseInt(options.page, 10) || 1);
    const pageSize = Math.max(1, Math.min(1000, Number.parseInt(options.pageSize, 10) || 50));
    const offset = (page - 1) * pageSize;

    const filters = options.filters || {};
    const whereClauses = [];
    const params = [];

    // 1. Trashed filter
    if (typeof filters.trashed === 'boolean') {
      whereClauses.push('trashed = ?');
      params.push(filters.trashed ? 1 : 0);
    } else if (typeof filters.trashed === 'number') {
      whereClauses.push('trashed = ?');
      params.push(filters.trashed ? 1 : 0);
    } else if (filters.activeGroupFilter === 'trash') {
      whereClauses.push('trashed = 1');
    } else if (filters.trashed === 'all' || filters.includeTrashed === true) {
      // Do not filter on trashed
    } else {
      whereClauses.push('trashed = 0');
    }

    // 2. Group filter (handles 'ungrouped' or empty string as ungrouped)
    const targetGroup = filters.groupId !== undefined ? filters.groupId : filters.activeGroupFilter;
    if (targetGroup === 'ungrouped' || targetGroup === '') {
      whereClauses.push("(group_id IS NULL OR group_id = '')");
    } else if (targetGroup && targetGroup !== 'all' && targetGroup !== 'trash') {
      whereClauses.push('group_id = ?');
      params.push(String(targetGroup));
    }

    // 3. Search filter (matching id, name, title, tag, proxy_text)
    const searchTerm = String(filters.name || filters.query || filters.search || '').trim();
    if (searchTerm) {
      const escaped = searchTerm.replace(/([\\%_])/g, '\\$1');
      whereClauses.push("(id LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\' OR tag LIKE ? ESCAPE '\\' OR proxy_text LIKE ? ESCAPE '\\')");
      params.push(`%${escaped}%`, `%${escaped}%`, `%${escaped}%`, `%${escaped}%`, `%${escaped}%`);
    }

    // 4. Exact ID filter
    if (filters.id) {
      whereClauses.push('id = ?');
      params.push(String(filters.id));
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    // 5. Total count query
    const countSql = `SELECT count(*) as total FROM profiles ${whereSql};`;
    const countRow = this.db.prepare(countSql).get(...params);
    const total = Number(countRow?.total || 0);

    if (total === 0 || offset >= total) {
      return { total, page, pageSize, rows: [], counts: this.getProfileCounts() };
    }

    // 6. Sort clause
    let sortCol = 'number';
    let sortDir = 'ASC';
    const rawSort = options.sort;
    if (typeof rawSort === 'string') {
      const parts = rawSort.trim().split(/\s+/);
      if (parts[0]) sortCol = parts[0].toLowerCase();
      if (parts[1] && /^desc$/i.test(parts[1])) sortDir = 'DESC';
    } else if (rawSort && typeof rawSort === 'object') {
      if (rawSort.field) sortCol = String(rawSort.field).toLowerCase();
      if (rawSort.order && /^desc$/i.test(String(rawSort.order))) sortDir = 'DESC';
    }

    let orderSql = `ORDER BY number ${sortDir}, id ${sortDir}`;
    if (sortCol === 'name') {
      orderSql = `ORDER BY name ${sortDir}, id ASC`;
    } else if (sortCol === 'createdat' || sortCol === 'created_at') {
      orderSql = `ORDER BY created_at ${sortDir}, id ASC`;
    } else if (sortCol === 'updatedat' || sortCol === 'updated_at') {
      orderSql = `ORDER BY updated_at ${sortDir}, id ASC`;
    }

    // 7. Page data query (limit/offset)
    const pageSql = `SELECT id, number, name, title, tag, proxy_text, group_id, trashed, trashed_at, created_at, updated_at, data FROM profiles ${whereSql} ${orderSql} LIMIT ? OFFSET ?;`;
    const queryParams = [...params, pageSize, offset];
    const rawRows = this.db.prepare(pageSql).all(...queryParams);

    // 8. Decrypt and project lightweight summary rows (only for current page)
    const rows = rawRows.map((row) => {
      const decoded = decodeProfileData(row.data);
      if (!decoded) {
        return {
          id: String(row.id),
          number: row.number != null ? Number(row.number) : null,
          name: String(row.name || row.id),
          title: row.title || '',
          groupId: row.group_id != null ? String(row.group_id) : null,
          browser: 'Unknown',
          proxy: '',
          proxyId: null,
          networkMode: 'corrupted',
          corrupted: true,
          tag: row.tag || '',
          tags: row.tag ? [row.tag] : [],
          note: '',
          notes: '',
          allowFailedProxy: false,
          running: false,
          trashed: Boolean(row.trashed),
          trashedAt: row.trashed_at || null,
          createdAt: row.created_at || null,
          updatedAt: row.updated_at || null,
          _isSummaryProjection: true,
        };
      }

      const noteVal = decoded.note ?? decoded.notes ?? '';
      return {
        id: String(row.id),
        number: row.number != null ? Number(row.number) : (decoded.number != null ? Number(decoded.number) : null),
        name: String(row.name || decoded.name || row.id),
        title: row.title || decoded.title || '',
        groupId: row.group_id != null ? String(row.group_id) : (decoded.groupId != null ? String(decoded.groupId) : null),
        browser: decoded.browser || 'Google Chrome',
        proxy: decoded.proxy || 'direct',
        proxyId: decoded.proxyId || null,
        networkMode: decoded.networkMode || 'direct',
        corrupted: false,
        tag: row.tag || decoded.tag || '',
        tags: Array.isArray(decoded.tags) ? decoded.tags : ((row.tag || decoded.tag) ? [row.tag || decoded.tag] : []),
        note: noteVal,
        notes: decoded.notes ?? noteVal,
        allowFailedProxy: Boolean(decoded.allowFailedProxy),
        exitIp: decoded.exitIp || null,
        exitCountryCode: decoded.exitCountryCode || null,
        exitCheckedAt: decoded.exitCheckedAt || null,
        platform: decoded.platform ? { type: decoded.platform.type, startUrl: decoded.platform.startUrl } : undefined,
        os: decoded.os || undefined,
        running: Boolean(decoded.running),
        trashed: Boolean(row.trashed),
        trashedAt: row.trashed_at || (decoded.trashedAt ? String(decoded.trashedAt) : null),
        createdAt: row.created_at || (decoded.createdAt ? String(decoded.createdAt) : null),
        updatedAt: row.updated_at || (decoded.updatedAt ? String(decoded.updatedAt) : null),
        _isSummaryProjection: true,
      };
    });

    return { total, page, pageSize, rows, counts: this.getProfileCounts() };
  }

  /**
   * Retrieves aggregated profile counts by group and trashed status.
   * Single-query aggregation without scanning full JSON blobs.
   * @returns {{ total: number, active: number, trashed: number, ungrouped: number, byGroup: Object.<string, number> }}
   */
  getProfileCounts() {
    if (!this.db || !this.isOpen) {
      throw new Error('Database is not open');
    }
    const rows = this.db.prepare(
      'SELECT group_id, trashed, COUNT(*) AS cnt FROM profiles GROUP BY group_id, trashed;'
    ).all();
    let total = 0;
    let active = 0;
    let trashed = 0;
    let ungrouped = 0;
    const byGroup = {};
    for (const r of rows) {
      const count = Number(r.cnt) || 0;
      const isTrashed = Number(r.trashed) === 1;
      const gid = r.group_id;
      total += count;
      if (isTrashed) {
        trashed += count;
      } else {
        active += count;
        if (!gid || gid === '') {
          ungrouped += count;
        } else {
          byGroup[gid] = (byGroup[gid] || 0) + count;
        }
      }
    }
    return { total, active, trashed, ungrouped, byGroup };
  }

  /**
   * Safely allocates the next available sequence number for profile creation.
   * @returns {number}
   */
  getNextProfileNumber() {
    if (!this.db || !this.isOpen) {
      throw new Error('Database is not open');
    }
    const row = this.db.prepare('SELECT COALESCE(MAX(number), 0) + 1 AS next FROM profiles;').get();
    return Number(row?.next || 1);
  }

  /**
   * Soft-delete profiles into the Recycle Bin (Issue #37)
   * @param {string[]} ids
   * @param {string} [nowIso]
   * @returns {string[] & { ids: string[], dataDirs: string[] }}
   */
  trashProfiles(ids, nowIso = new Date().toISOString()) {
    if (!Array.isArray(ids) || !ids.length) {
      const empty = [];
      empty.ids = [];
      empty.dataDirs = [];
      return empty;
    }
    const trashedIds = [];
    const dataDirs = [];
    this.db.exec('BEGIN TRANSACTION;');
    try {
      for (const id of ids) {
        const safeId = String(id);
        const row = this._statements.getProfile.get(safeId);
        if (!row || !row.data) continue;
        const profile = decodeProfileData(row.data);
        if (!profile) continue;
        profile.trashed = true;
        profile.trashedAt = nowIso;
        profile.updatedAt = nowIso;
        const data = encodeProfileData(profile);

        this._statements.updateProfileTrash.run(1, nowIso, nowIso, data, safeId);
        trashedIds.push(safeId);
        if (profile.dataDir || profile.profileRoot) {
          dataDirs.push(profile.dataDir || profile.profileRoot);
        } else if (this.profileDataRoot) {
          dataDirs.push(path.join(this.profileDataRoot, safeId));
        }
      }
      this.db.exec('COMMIT;');
    } catch (err) {
      try { this.db.exec('ROLLBACK;'); } catch (_) {}
      throw err;
    }
    const res = trashedIds;
    res.ids = trashedIds;
    res.dataDirs = dataDirs;
    return res;
  }

  /**
   * Restore profiles from the Recycle Bin (Issue #37)
   * @param {string[]} ids
   * @returns {string[] & { ids: string[], dataDirs: string[] }}
   */
  restoreProfiles(ids) {
    if (!Array.isArray(ids) || !ids.length) {
      const empty = [];
      empty.ids = [];
      empty.dataDirs = [];
      return empty;
    }
    const restoredIds = [];
    const dataDirs = [];
    const nowIso = new Date().toISOString();
    this.db.exec('BEGIN TRANSACTION;');
    try {
      for (const id of ids) {
        const safeId = String(id);
        const row = this._statements.getProfile.get(safeId);
        if (!row || !row.data) continue;
        const profile = decodeProfileData(row.data);
        if (!profile) continue;
        profile.trashed = false;
        profile.trashedAt = null;
        profile.updatedAt = nowIso;
        const data = encodeProfileData(profile);

        this._statements.updateProfileTrash.run(0, null, nowIso, data, safeId);
        restoredIds.push(safeId);
        if (profile.dataDir || profile.profileRoot) {
          dataDirs.push(profile.dataDir || profile.profileRoot);
        } else if (this.profileDataRoot) {
          dataDirs.push(path.join(this.profileDataRoot, safeId));
        }
      }
      this.db.exec('COMMIT;');
    } catch (err) {
      try { this.db.exec('ROLLBACK;'); } catch (_) {}
      throw err;
    }
    const res = restoredIds;
    res.ids = restoredIds;
    res.dataDirs = dataDirs;
    return res;
  }

  /**
   * Permanently delete profiles and their extension assignments (Issue #37 purge)
   * @param {string[]} ids
   * @returns {string[] & { ids: string[], dataDirs: string[] }}
   */
  deleteProfiles(ids) {
    if (!Array.isArray(ids) || !ids.length) {
      const empty = [];
      empty.ids = [];
      empty.dataDirs = [];
      return empty;
    }
    const deletedIds = [];
    const dataDirs = [];
    this.db.exec('BEGIN TRANSACTION;');
    try {
      for (const id of ids) {
        const safeId = String(id);
        const row = this._statements.getProfile.get(safeId);
        if (row?.data) {
          const decoded = decodeProfileData(row.data);
          if (decoded?.dataDir || decoded?.profileRoot) {
            dataDirs.push(decoded.dataDir || decoded.profileRoot);
          } else if (this.profileDataRoot) {
            dataDirs.push(path.join(this.profileDataRoot, safeId));
          }
        } else if (this.profileDataRoot) {
          dataDirs.push(path.join(this.profileDataRoot, safeId));
        }
        this._statements.clearAssignmentsForProfile.run(safeId);
        const res = this._statements.deleteProfile.run(safeId);
        if (res.changes > 0) deletedIds.push(safeId);
      }
      this.db.exec('COMMIT;');
    } catch (err) {
      try { this.db.exec('ROLLBACK;'); } catch (_) {}
      throw err;
    }
    const res = deletedIds;
    res.ids = deletedIds;
    res.dataDirs = dataDirs;
    return res;
  }

  /**
   * Empty all profiles from the Recycle Bin
   * @returns {string[] & { ids: string[], dataDirs: string[] }}
   */
  emptyTrash() {
    const rows = this._statements.getTrashedProfileIds.all();
    const trashedIds = rows.map((r) => String(r.id));
    if (!trashedIds.length) {
      const empty = [];
      empty.ids = [];
      empty.dataDirs = [];
      return empty;
    }
    return this.deleteProfiles(trashedIds);
  }

  /* ---------------- Group operations ---------------- */

  saveGroup(group) {
    if (!group || typeof group !== 'object' || !group.id) return;
    this._statements.upsertGroup.run(
      String(group.id),
      String(group.name || ''),
      group.color || null,
      group.note || null,
      Number(group.sort) || 0,
      group.createdAt || new Date().toISOString(),
      JSON.stringify(group)
    );
  }

  saveGroups(groups) {
    if (!Array.isArray(groups)) return;
    this.db.exec('BEGIN TRANSACTION;');
    try {
      for (const group of groups) {
        this.saveGroup(group);
      }
      this.db.exec('COMMIT;');
    } catch (err) {
      try { this.db.exec('ROLLBACK;'); } catch (_) {}
      throw err;
    }
  }

  listGroups() {
    const rows = this._statements.getAllGroups.all();
    const result = [];
    for (const row of rows) {
      try { result.push(JSON.parse(row.data)); } catch (_) {}
    }
    return result;
  }

  deleteGroup(id) {
    this._statements.deleteGroup.run(String(id));
  }

  /* ---------------- Extension operations ---------------- */

  saveExtension(extension) {
    if (!extension || typeof extension !== 'object' || !extension.id) return;
    this._statements.upsertExtension.run(
      String(extension.id),
      String(extension.name || ''),
      String(extension.version || ''),
      String(extension.path || ''),
      extension.builtIn ? 1 : 0,
      extension.addedAt || null,
      JSON.stringify(extension)
    );
  }

  saveExtensions(extensions) {
    if (!Array.isArray(extensions)) return;
    this.db.exec('BEGIN TRANSACTION;');
    try {
      for (const ext of extensions) {
        this.saveExtension(ext);
      }
      this.db.exec('COMMIT;');
    } catch (err) {
      try { this.db.exec('ROLLBACK;'); } catch (_) {}
      throw err;
    }
  }

  listExtensions() {
    const rows = this._statements.getAllExtensions.all();
    const result = [];
    for (const row of rows) {
      try { result.push(JSON.parse(row.data)); } catch (_) {}
    }
    return result;
  }

  deleteExtension(id) {
    const safeId = String(id);
    this.db.exec('BEGIN TRANSACTION;');
    try {
      this._statements.clearAssignmentsForExtension.run(safeId);
      this._statements.deleteExtension.run(safeId);
      this.db.exec('COMMIT;');
    } catch (err) {
      try { this.db.exec('ROLLBACK;'); } catch (_) {}
      throw err;
    }
  }

  /* ---------------- Assignment operations ---------------- */

  getAssignments() {
    const rows = this._statements.getAllAssignments.all();
    const map = new Map();
    for (const row of rows) {
      const pid = String(row.profile_id);
      const eid = String(row.extension_id);
      if (!map.has(pid)) map.set(pid, new Set());
      map.get(pid).add(eid);
    }
    return map;
  }

  setAssignments(profileId, extensionIds) {
    const safePid = String(profileId);
    this.db.exec('BEGIN TRANSACTION;');
    try {
      this._statements.clearAssignmentsForProfile.run(safePid);
      for (const eid of extensionIds) {
        this._statements.addAssignment.run(safePid, String(eid));
      }
      this.db.exec('COMMIT;');
    } catch (err) {
      try { this.db.exec('ROLLBACK;'); } catch (_) {}
      throw err;
    }
  }

  assignExtension(extensionId, profileIds, enabled) {
    const safeEid = String(extensionId);
    this.db.exec('BEGIN TRANSACTION;');
    try {
      for (const pid of profileIds) {
        const safePid = String(pid);
        if (enabled) {
          this._statements.addAssignment.run(safePid, safeEid);
        } else {
          this._statements.removeAssignment.run(safePid, safeEid);
        }
      }
      this.db.exec('COMMIT;');
    } catch (err) {
      try { this.db.exec('ROLLBACK;'); } catch (_) {}
      throw err;
    }
  }

  /* ---------------- Metadata & Settings ---------------- */

  getMeta(key, defaultValue = null) {
    const row = this._statements.getMeta.get(String(key));
    if (!row || row.value == null) return defaultValue;
    try {
      return JSON.parse(row.value);
    } catch (_) {
      return row.value;
    }
  }

  setMeta(key, value) {
    this._statements.setMeta.run(String(key), JSON.stringify(value));
  }

  getAllMeta() {
    const rows = this._statements.getAllMeta.all();
    const result = {};
    for (const row of rows) {
      try {
        result[row.key] = JSON.parse(row.value);
      } catch (_) {
        result[row.key] = row.value;
      }
    }
    return result;
  }

  /* ---------------- Export & Cloud compatibility ---------------- */

  /**
   * Export the complete engine state formatted identically to the legacy JSON file.
   * Compatible with cloud-sync.js and external tooling.
   */
  exportEngineState() {
    const profiles = this.getAllProfiles();
    const groups = this.listGroups();
    const extensions = this.listExtensions();
    const assignmentMap = this.getAssignments();
    const assignments = Object.fromEntries(
      [...assignmentMap.entries()].map(([pid, set]) => [pid, [...set]])
    );
    const meta = this.getAllMeta();

    return {
      profiles,
      groups,
      extensions,
      assignments,
      kernelPolicyVersion: meta.kernelPolicyVersion ?? 1,
      preferIndependentKernel: meta.preferIndependentKernel ?? true,
      allowSystemBrowserFallback: meta.allowSystemBrowserFallback ?? false,
      systemBrowserPath: meta.systemBrowserPath ?? null,
    };
  }

  /**
   * Serialize exported state to JSON string.
   */
  dumpToJson(indent = 2) {
    return JSON.stringify(this.exportEngineState(), null, indent);
  }
}

module.exports = {
  ProfileStoreSqlite,
};
