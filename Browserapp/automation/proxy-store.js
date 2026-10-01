'use strict';

const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const {
  parseProxy,
  parseProxyInput,
  displayProxy,
  normalizeIpLookupChannel,
} = require('../proxy-forwarder');
const {
  profileProxyAssociation,
  normalizedProxyAssociationId,
  sameProxyEndpoint,
} = require('../engine/proxy-helpers');

const MAX_PROXY_URL_LENGTH = 64 * 1024;
// Upper bound for the per-proxy window cap. 0 means "no limit" and is the default, so a
// stored record from an older build keeps working without migration.
const MAX_PROXY_CONCURRENCY = 1000;
const MAX_PROXY_CREDENTIAL_LENGTH = 32 * 1024;
const PROXY_STORE_CORRUPTION_CODE = 'ERR_PROXY_STORE_CORRUPT';

/**
 * Local proxy library (proxy-list CRUD, self-contained).
 */

function uid() {
  return crypto.randomBytes(8).toString('hex');
}

function ownValue(input, keys) {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(input || {}, key) && input[key] != null) {
      return { present: true, value: input[key] };
    }
  }
  return { present: false, value: undefined };
}

function firstNonEmpty(input, keys) {
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(input || {}, key) || input[key] == null) continue;
    const value = String(input[key]).trim();
    if (value) return value;
  }
  return '';
}

function firstCredential(input, keys) {
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(input || {}, key) || input[key] == null) continue;
    const value = String(input[key]);
    if (value) return value;
  }
  return '';
}

function proxyEndpointKey(proxy) {
  if (!proxy) return '';
  return [proxy.protocol, proxy.host, proxy.port].join('\u0000');
}

function isRedactedCredential(value) {
  const text = String(value ?? '');
  if (!text) return true;
  return /^(?:\*{3,}|•{3,}|<redacted>|\[redacted\])$/i.test(text.trim());
}

function parseStoredProxy(value) {
  if (!value) return null;
  try {
    return parseProxy(value);
  } catch (_) {
    return null;
  }
}

function normalizeProxyRecord(input = {}, existing = null) {
  const isMigration = Boolean(existing && input === existing);
  const requestedName = String(input.name || existing?.name || '').trim().slice(0, 120);
  const refreshUrl = String(input.refreshUrl ?? input.refresh_url ?? existing?.refreshUrl ?? '').slice(0, 1000);
  const ipChannel = normalizeIpLookupChannel(input.ipChannel ?? input.ip_channel ?? existing?.ipChannel);

  const concurrencyInput = ownValue(input, ['maxConcurrency', 'max_concurrency', 'concurrencyLimit', 'concurrency']);
  const requestedConcurrency = concurrencyInput.present
    ? Number.parseInt(concurrencyInput.value, 10)
    : Number.parseInt(existing && existing.maxConcurrency, 10);
  const maxConcurrency = Number.isInteger(requestedConcurrency) && requestedConcurrency > 0
    ? Math.min(requestedConcurrency, MAX_PROXY_CONCURRENCY)
    : 0;

  const existingRaw = firstNonEmpty(existing, ['raw', 'proxy', 'proxy_url', 'proxyUrl']);
  const explicitRaw = firstNonEmpty(input, ['raw', 'proxy', 'proxy_url', 'proxyUrl']);
  if (existingRaw.length > MAX_PROXY_URL_LENGTH || explicitRaw.length > MAX_PROXY_URL_LENGTH) {
    throw new Error('代理 URL 过长');
  }
  const existingParsed = parseStoredProxy(existingRaw);
  const explicitParsed = explicitRaw ? parseProxy(explicitRaw) : null;
  const explicitAuthAction = String(input.proxyAuthAction ?? input.proxy_auth_action ?? '').trim().toLowerCase();
  const clearExplicitAuth = explicitAuthAction === 'clear';
  const protocolInput = ownValue(input, ['protocol', 'type', 'proxy_type', 'proxyType']);
  const hostInput = ownValue(input, ['host', 'proxy_host', 'proxyHost', 'server']);
  const portInput = ownValue(input, ['port', 'proxy_port', 'proxyPort']);
  const usernameInput = ownValue(input, ['username', 'user', 'proxy_user', 'proxy_username', 'proxyUsername']);
  const passwordInput = ownValue(input, ['password', 'pass', 'proxy_password', 'proxyPassword']);
  const existingUsername = String(existingParsed?.username
    || firstCredential(existing, ['username', 'user', 'proxy_user', 'proxy_username', 'proxyUsername']));
  const existingPassword = String(existingParsed?.password
    || firstCredential(existing, ['password', 'pass', 'proxy_password', 'proxyPassword']));
  const credentialPatchChangesExisting = (usernameInput.present
    && !isRedactedCredential(usernameInput.value)
    && String(usernameInput.value) !== existingUsername)
    || (passwordInput.present
      && !isRedactedCredential(passwordInput.value)
      && String(passwordInput.value) !== existingPassword);
  const endpointChanged = Boolean(explicitParsed && existingParsed
    && proxyEndpointKey(explicitParsed) !== proxyEndpointKey(existingParsed));
  const rawIsAuthoritative = clearExplicitAuth || (Boolean(explicitParsed)
    // A bare URL for the same endpoint is the normal redacted round-trip form,
    // not an instruction to erase credentials. A changed credential field wins
    // over an echoed raw URL; otherwise embedded auth/new endpoints stay authoritative.
    && !credentialPatchChangesExisting
    && (Boolean(explicitParsed.authenticated) || endpointChanged));

  const base = explicitParsed || existingParsed || {
    protocol: 'socks5', host: '', port: 0, username: '', password: '',
  };
  let protocol = String(base.protocol || 'socks5').toLowerCase();
  let host = String(base.host || '').trim();
  let port = Number(base.port);
  let username = String(base.username || '');
  let password = String(base.password || '');

  if (clearExplicitAuth) {
    username = '';
    password = '';
  }

  // Some older exports stored credentials as separate fields while keeping a
  // bare `raw` address. Preserve those fields during migration/restart unless a
  // new raw URL explicitly replaces the existing proxy record.
  if (!rawIsAuthoritative) {
    if (!username) username = firstCredential(existing, ['username', 'user', 'proxy_user', 'proxy_username', 'proxyUsername']);
    if (!password) password = firstCredential(existing, ['password', 'pass', 'proxy_password', 'proxyPassword']);
  }

  if (!rawIsAuthoritative) {
    if (protocolInput.present && String(protocolInput.value).trim()) {
      protocol = String(protocolInput.value).trim().toLowerCase();
    }
    if (hostInput.present && String(hostInput.value).trim()) host = String(hostInput.value).trim();
    if (portInput.present && Number(portInput.value) > 0) port = Number(portInput.value);
    // Empty/masked values are treated as a redacted UI/API round trip. Clearing
    // credentials is intentionally available only through proxyAuthAction=clear.
    if (usernameInput.present && !isRedactedCredential(usernameInput.value)) username = String(usernameInput.value);
    if (passwordInput.present && !isRedactedCredential(passwordInput.value)) password = String(passwordInput.value);
  }

  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('主机和端口必填');
  if (username.length > MAX_PROXY_CREDENTIAL_LENGTH) throw new Error('代理用户名过长');
  if (password.length > MAX_PROXY_CREDENTIAL_LENGTH) throw new Error('代理密码过长');

  const remarkInput = ownValue(input, ['remark', 'note']);
  const storedRemark = firstNonEmpty(existing, ['remark', 'note']);
  let remark = '';
  if (isMigration) {
    remark = firstNonEmpty(input, ['remark', 'note'])
      || explicitParsed?.remark
      || existingParsed?.remark
      || '';
  } else if (remarkInput.present) {
    remark = String(remarkInput.value).trim();
  } else if (explicitRaw) {
    remark = explicitParsed?.remark || '';
  } else {
    remark = storedRemark || existingParsed?.remark || '';
  }
  remark = remark.slice(0, 500);

  const parsed = parseProxyInput({ protocol, host, port, username, password, remark });
  if (!parsed) throw new Error('当前记录是直连，请填写代理地址');
  if (parsed.raw.length > MAX_PROXY_URL_LENGTH) throw new Error('代理 URL 过长');

  const now = new Date().toISOString();
  return {
    id: existing?.id || String(input.id || uid()),
    name: requestedName || parsed.name,
    protocol: parsed.protocol,
    host: parsed.host,
    port: parsed.port,
    username: parsed.username || '',
    password: parsed.password || '',
    raw: parsed.raw,
    chromeUrl: parsed.chromeUrl,
    authenticated: parsed.authenticated,
    refreshUrl,
    ipChannel,
    maxConcurrency,
    remark,
    lastCheck: existing?.lastCheck || null,
    lastIp: existing?.lastIp || '',
    lastCountryCode: existing?.lastCountryCode || '',
    lastLatencyMs: existing?.lastLatencyMs ?? null,
    lastNetworkType: existing?.lastNetworkType || '',
    lastErrorClass: existing?.lastErrorClass || '',
    lastCheckOk: existing?.lastCheckOk ?? null,
    create_time: existing?.create_time || now,
    update_time: isMigration ? (existing?.update_time || now) : now,
  };
}

function cloneData(value) {
  return JSON.parse(JSON.stringify(value));
}

function proxyStoreCorruption(message, cause = null) {
  const error = new Error(message);
  error.code = PROXY_STORE_CORRUPTION_CODE;
  if (cause) error.cause = cause;
  return error;
}

function decodeStoredData(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw proxyStoreCorruption(`代理库 JSON 无效: ${error.message}`, error);
  }
  if (!Array.isArray(parsed) && (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.items))) {
    throw proxyStoreCorruption('代理库文件格式无效');
  }
  const sourceItems = Array.isArray(parsed) ? parsed : parsed.items;
  const items = sourceItems.map((item) => {
    try {
      return { ...item, ...normalizeProxyRecord(item, item) };
    } catch (_) {
      return item;
    }
  });
  return {
    data: { version: 2, items },
    migrated: Array.isArray(parsed)
      || Number(parsed.version) !== 2
      || JSON.stringify(sourceItems) !== JSON.stringify(items),
  };
}

class ProxyStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = { version: 2, items: [] };
    this._mutationQueue = Promise.resolve();
  }

  _enqueueMutation(operation) {
    const queued = this._mutationQueue.then(operation, operation);
    this._mutationQueue = queued.catch(() => {});
    return queued;
  }

  flush() {
    return this._mutationQueue;
  }

  async _writeAtomic(targetPath, payload) {
    const directory = path.dirname(targetPath);
    await fsp.mkdir(directory, { recursive: true });
    const temporary = `${targetPath}.tmp-${process.pid}-${uid()}`;
    let handle = null;
    try {
      handle = await fsp.open(temporary, 'wx', 0o600);
      await handle.writeFile(payload, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await fsp.rename(temporary, targetPath);
      try {
        const directoryHandle = await fsp.open(directory, 'r');
        await directoryHandle.sync();
        await directoryHandle.close();
      } catch (_) {}
    } finally {
      if (handle) await handle.close().catch(() => {});
      await fsp.rm(temporary, { force: true }).catch(() => {});
    }
  }

  async _persistData(nextData, { allowCorruptReplace = false } = {}) {
    const payload = JSON.stringify(nextData, null, 2);
    let current = { kind: 'missing', raw: null };
    try {
      const raw = await fsp.readFile(this.filePath, 'utf8');
      decodeStoredData(raw);
      current = { kind: 'valid', raw };
    } catch (error) {
      if (error.code === 'ENOENT') {
        current = { kind: 'missing', raw: null };
      } else if (error.code === PROXY_STORE_CORRUPTION_CODE) {
        // Keep the exact bytes available before replacing a corrupt main file.
        // If this snapshot cannot be written, the original file is left in
        // place and the new state is not written over it.
        const raw = await fsp.readFile(this.filePath, 'utf8');
        const corruptPath = `${this.filePath}.corrupt-${Date.now()}-${uid()}`;
        try {
          await this._writeAtomic(corruptPath, raw);
        } catch (preserveError) {
          const failure = new Error(`无法保留损坏的代理库文件: ${preserveError.message}`);
          failure.code = PROXY_STORE_CORRUPTION_CODE;
          failure.cause = preserveError;
          throw failure;
        }
        current = { kind: 'corrupt', raw, corruptPath };
        if (!allowCorruptReplace) {
          const failure = proxyStoreCorruption(`代理库损坏且没有可用备份: ${error.message}`, error);
          failure.corruptPath = corruptPath;
          throw failure;
        }
      } else {
        throw error;
      }
    }

    if (current.kind === 'valid') await this._writeAtomic(this.filePath + '.bak', current.raw);
    await this._writeAtomic(this.filePath, payload);
    if (current.kind !== 'valid') {
      try {
        await fsp.access(this.filePath + '.bak');
      } catch (_) {
        await this._writeAtomic(this.filePath + '.bak', payload).catch(() => {});
      }
    }
  }

  async _readCandidate(candidatePath) {
    const [raw, stat] = await Promise.all([
      fsp.readFile(candidatePath, 'utf8'),
      fsp.stat(candidatePath),
    ]);
    return { path: candidatePath, raw, stat, ...decodeStoredData(raw) };
  }

  async _recoveryCandidates() {
    const directory = path.dirname(this.filePath);
    const base = path.basename(this.filePath);
    let names = [];
    try {
      names = await fsp.readdir(directory);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const paths = names
      .filter((name) => name.startsWith(base + '.tmp-'))
      .map((name) => path.join(directory, name));
    paths.push(this.filePath + '.tmp', this.filePath + '.bak');

    const valid = [];
    for (const candidatePath of [...new Set(paths)]) {
      try {
        valid.push(await this._readCandidate(candidatePath));
      } catch (_) {}
    }
    return valid.sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs);
  }

  async _cleanupRecoveryTemps() {
    const directory = path.dirname(this.filePath);
    const base = path.basename(this.filePath);
    let names = [];
    try {
      names = await fsp.readdir(directory);
    } catch (_) {
      return;
    }
    const stale = names
      .filter((name) => name === base + '.tmp' || name.startsWith(base + '.tmp-'))
      .map((name) => fsp.rm(path.join(directory, name), { force: true }).catch(() => {}));
    await Promise.all(stale);
  }

  async load() {
    return this._enqueueMutation(async () => {
      let main = null;
      let mainFailure = null;
      try {
        main = await this._readCandidate(this.filePath);
      } catch (error) {
        if (error.code === 'ENOENT') {
          mainFailure = { kind: 'missing', error };
        } else if (error.code === PROXY_STORE_CORRUPTION_CODE) {
          mainFailure = { kind: 'corrupt', error };
        } else {
          throw error;
        }
      }

      if (main) {
        if (main.migrated) await this._persistData(main.data);
        this.data = main.data;
        await this._cleanupRecoveryTemps();
        return cloneData(this.data);
      }

      const recovered = (await this._recoveryCandidates())[0] || null;
      if (recovered) {
        await this._persistData(recovered.data, { allowCorruptReplace: mainFailure?.kind === 'corrupt' });
        this.data = recovered.data;
        await this._cleanupRecoveryTemps();
        return cloneData(this.data);
      }

      if (mainFailure?.kind === 'corrupt') {
        const failure = new Error(`代理库损坏且没有可用备份: ${mainFailure.error.message}`);
        failure.code = PROXY_STORE_CORRUPTION_CODE;
        failure.cause = mainFailure.error;
        throw failure;
      }

      const empty = { version: 2, items: [] };
      await this._persistData(empty);
      this.data = empty;
      return cloneData(this.data);
    });
  }

  async save() {
    return this._enqueueMutation(async () => {
      const snapshot = cloneData(this.data);
      await this._persistData(snapshot);
      return cloneData(snapshot);
    });
  }

  _commitMutation(mutator) {
    return this._enqueueMutation(async () => {
      const draft = cloneData(this.data);
      const result = await mutator(draft);
      await this._persistData(draft);
      this.data = draft;
      return cloneData(result);
    });
  }

  list(filter = {}) {
    let items = cloneData(this.data.items);
    const q = String(filter.q || filter.keyword || '').trim().toLowerCase();
    if (q) {
      items = items.filter((item) => [item.name, item.host, item.protocol, item.remark, item.lastIp, String(item.port)]
        .join(' ').toLowerCase().includes(q));
    }
    if (filter.protocol) {
      items = items.filter((item) => item.protocol === String(filter.protocol).toLowerCase());
    }
    return items.sort((a, b) => String(b.update_time || '').localeCompare(String(a.update_time || '')));
  }

  get(id) {
    const item = this.data.items.find((entry) => entry.id === id);
    return item ? cloneData(item) : null;
  }

  async create(input) {
    return this._commitMutation((draft) => {
      if (draft.items.length >= 5000) throw new Error('代理数量已达上限 5000');
      const record = normalizeProxyRecord(input);
      if (draft.items.some((item) => item.id === record.id)) throw new Error('代理 ID 已存在: ' + record.id);
      draft.items.unshift(record);
      return record;
    });
  }

  async createMany(list = []) {
    if (!Array.isArray(list) || !list.length) throw new Error('请提供代理数组');
    if (list.length > 500) throw new Error('单次最多导入 500 条');
    return this._commitMutation((draft) => {
      if (draft.items.length + list.length > 5000) throw new Error('代理数量已达上限 5000');
      const created = list.map((item) => normalizeProxyRecord(item));
      const existingIds = new Set(draft.items.map((item) => item.id));
      const batchIds = new Set();
      for (const record of created) {
        if (existingIds.has(record.id)) throw new Error('代理 ID 已存在: ' + record.id);
        if (batchIds.has(record.id)) throw new Error('批量导入代理 ID 重复: ' + record.id);
        batchIds.add(record.id);
      }
      draft.items.unshift(...created);
      return created;
    });
  }

  async update(id, input) {
    return this._commitMutation((draft) => {
      const index = draft.items.findIndex((item) => item.id === id);
      if (index < 0) throw new Error('代理不存在: ' + id);
      const next = normalizeProxyRecord({ ...input, id }, draft.items[index]);
      draft.items[index] = next;
      return next;
    });
  }

  async remove(ids) {
    const set = new Set((Array.isArray(ids) ? ids : [ids]).map(String));
    return this._commitMutation((draft) => {
      const before = draft.items.length;
      draft.items = draft.items.filter((item) => !set.has(item.id));
      return { deleted: before - draft.items.length, ids: [...set] };
    });
  }

  async replaceAll(list = []) {
    if (!Array.isArray(list)) throw new Error('请提供代理数组');
    if (list.length > 5000) throw new Error('代理数量已达上限 5000');
    return this._commitMutation((draft) => {
      const items = list.map((item) => normalizeProxyRecord(item, item));
      const ids = new Set();
      for (const item of items) {
        if (ids.has(item.id)) throw new Error('代理 ID 重复: ' + item.id);
        ids.add(item.id);
      }
      draft.version = 2;
      draft.items = items;
      return items;
    });
  }

  async markCheck(id, result = {}) {
    return this._commitMutation((draft) => {
      const item = draft.items.find((entry) => entry.id === id);
      if (!item) throw new Error('代理不存在: ' + id);
      item.lastCheck = new Date().toISOString();
      item.lastIp = String(result.ip || '');
      item.lastCountryCode = String(result.countryCode || result.country_code || '');
      item.lastLatencyMs = Number.isFinite(Number(result.latencyMs)) ? Number(result.latencyMs) : null;
      item.lastNetworkType = String(result.networkType || '');
      item.lastErrorClass = result.errorClass ? String(result.errorClass) : '';
      item.lastCheckOk = !result.errorClass && Boolean(result.ip);
      item.update_time = item.lastCheck;
      return item;
    });
  }

  async markCheckError(id, error = {}) {
    return this._commitMutation((draft) => {
      const item = draft.items.find((entry) => entry.id === id);
      if (!item) throw new Error('代理不存在: ' + id);
      item.lastCheck = new Date().toISOString();
      item.lastLatencyMs = Number.isFinite(Number(error.latencyMs)) ? Number(error.latencyMs) : null;
      item.lastErrorClass = String(error.errorClass || error.code || 'unknown');
      item.lastCheckOk = false;
      item.update_time = item.lastCheck;
      return item;
    });
  }

  toChromeString(id) {
    const item = this.get(id);
    if (!item) return null;
    return item.raw;
  }


  summarizeUsage(profiles) {
    return summarizeProxyUsage(this.data.items, profiles);
  }

  canAssign(proxyOrId, profiles, targetOrOptions = null) {
    const proxy = typeof proxyOrId === 'string' ? this.get(proxyOrId) : proxyOrId;
    return canAssignProxy(proxy, profiles, targetOrOptions);
  }

  assertAssignmentAvailable(proxyOrId, profiles, targetOrOptions = null) {
    const proxy = typeof proxyOrId === 'string' ? this.get(proxyOrId) : proxyOrId;
    return assertProxyAssignmentAvailable(proxy, profiles, targetOrOptions);
  }

  display(item) {
    return displayProxy(item.raw);
  }
}


/**
 * Determine whether a given environment (profile) is associated with or configured to use a proxy.
 *
 * Checks explicit association IDs (proxyId, proxy_id, proxyLibraryId, proxy_library_id across top-level
 * and proxyMeta), and falls back to matching raw endpoints or canonical IP/host/port endpoints for
 * manually pasted proxies that do not carry a library record ID. Direct/offline network modes are
 * never matched.
 */
function profileMatchesProxy(profile, proxy) {
  if (!profile || typeof profile !== 'object' || !proxy) return false;
  if (profile.networkMode === 'direct' || /^(direct|offline|none)$/i.test(String(profile.proxy || '').trim())) {
    return false;
  }
  const proxyId = String(proxy.id || '').trim();
  const assoc = profileProxyAssociation(profile);
  const linkedId = normalizedProxyAssociationId(assoc?.value);
  if (linkedId) {
    return Boolean(proxyId && linkedId === proxyId);
  }
  const profileRaw = String(profile.proxy || profile.raw || profile.proxyUrl || '').trim();
  const proxyRaw = String(proxy.raw || '').trim();
  if (!profileRaw || !proxyRaw) return false;
  if (profileRaw === proxyRaw) return true;
  return sameProxyEndpoint(profileRaw, proxyRaw);
}

function normalizeProfileList(input) {
  if (!input) return [];
  if (Array.isArray(input)) return input;
  if (typeof input.values === 'function') return Array.from(input.values());
  if (typeof input === 'object') return Object.values(input);
  return [];
}

function normalizeProxyList(input) {
  if (!input) return [];
  if (Array.isArray(input)) return input;
  if (typeof input.list === 'function') return input.list();
  if (input.data && Array.isArray(input.data.items)) return input.data.items;
  if (Array.isArray(input.items)) return input.items;
  if (typeof input.values === 'function') return Array.from(input.values());
  if (typeof input === 'object' && input.id) return [input];
  return [];
}

function extractProxyLimit(proxy) {
  if (!proxy || typeof proxy !== 'object') return 0;
  const raw = Number.parseInt(
    proxy.maxConcurrency ?? proxy.max_concurrency ?? proxy.concurrencyLimit ?? proxy.concurrency,
    10
  );
  return Number.isInteger(raw) && raw > 0 ? Math.min(raw, MAX_PROXY_CONCURRENCY) : 0;
}

/**
 * Summarize proxy allocation and window concurrency usage across profiles (Issue #25).
 *
 * Pure function. For each proxy in the library, calculates:
 * - profiles: list of profiles currently assigned to this proxy (id and name)
 * - count / used: number of occupying profiles
 * - limit / maxConcurrency: concurrency cap (0 means unlimited)
 * - isOverLimit / overLimit: boolean, whether count exceeds limit (> limit when limit > 0)
 * - isFull: boolean, whether count has reached or exceeded limit (>= limit when limit > 0)
 * - isIdle / idle: boolean, whether count is 0
 * - available: remaining slots before reaching limit, or null if unlimited
 *
 * Returns an array with attached convenience getters:
 * - byId: Map<proxyId, itemSummary>
 * - idle: array of idle proxy summaries
 * - inUse: array of proxies currently in use
 * - overLimit: array of proxies exceeding their limit
 * - full: array of proxies that have reached their limit
 */
function summarizeProxyUsage(proxies, profiles) {
  const proxyList = normalizeProxyList(proxies);
  const profileList = normalizeProfileList(profiles);

  const results = proxyList.map((proxy) => {
    const limit = extractProxyLimit(proxy);

    const boundProfiles = profileList
      .filter((profile) => profileMatchesProxy(profile, proxy))
      .map((profile) => ({
        id: String(profile.id),
        name: String(profile.name || profile.title || profile.id),
      }));

    const count = boundProfiles.length;
    const isOverLimit = limit > 0 && count > limit;
    const isFull = limit > 0 && count >= limit;
    const isIdle = count === 0;

    return {
      id: String(proxy.id || ''),
      name: String(proxy.name || (proxy.host && proxy.port ? `${proxy.host}:${proxy.port}` : proxy.raw || '')),
      proxy,
      profiles: boundProfiles,
      count,
      used: count,
      limit,
      maxConcurrency: limit,
      isOverLimit,
      overLimit: isOverLimit,
      isFull,
      isIdle,
      idle: isIdle,
      available: limit > 0 ? Math.max(0, limit - count) : null,
    };
  });

  const byId = new Map(results.map((item) => [item.id, item]));
  Object.defineProperties(results, {
    byId: { value: byId, enumerable: false },
    idle: { get: () => results.filter((item) => item.isIdle), enumerable: false },
    inUse: { get: () => results.filter((item) => !item.isIdle), enumerable: false },
    overLimit: { get: () => results.filter((item) => item.isOverLimit), enumerable: false },
    full: { get: () => results.filter((item) => item.isFull), enumerable: false },
  });

  return results;
}

/**
 * Check whether assigning a proxy to a profile is allowed under its maxConcurrency cap.
 *
 * If targetProfileId (or target profile object) is specified, its existing binding does not count
 * against the limit (i.e. saving an existing profile without switching proxies does not trigger
 * self-blocking).
 */
function canAssignProxy(proxyOrId, profiles, targetOrOptions = null) {
  let targetProfileId = null;
  let proxy = proxyOrId;

  if (targetOrOptions && typeof targetOrOptions === 'object') {
    if ('id' in targetOrOptions && !('targetProfileId' in targetOrOptions)) {
      targetProfileId = targetOrOptions.id;
    } else {
      targetProfileId = targetOrOptions.targetProfileId ?? targetOrOptions.targetId ?? null;
      if (typeof proxyOrId === 'string') {
        if (targetOrOptions.store?.get) proxy = targetOrOptions.store.get(proxyOrId);
        else if (Array.isArray(targetOrOptions.proxies)) proxy = targetOrOptions.proxies.find((p) => p.id === proxyOrId);
      }
    }
  } else if (targetOrOptions != null) {
    targetProfileId = String(targetOrOptions);
  }

  if (!proxy) {
    return { ok: true, count: 0, limit: 0, reason: null, proxy: null, occupyingProfiles: [] };
  }

  const limit = extractProxyLimit(proxy);
  const profileList = normalizeProfileList(profiles);
  const targetIdStr = targetProfileId != null ? String(targetProfileId).trim() : null;

  const occupyingProfiles = profileList
    .filter((profile) => {
      if (targetIdStr && String(profile.id).trim() === targetIdStr) return false;
      return profileMatchesProxy(profile, proxy);
    })
    .map((profile) => ({
      id: String(profile.id),
      name: String(profile.name || profile.title || profile.id),
    }));

  const count = occupyingProfiles.length;
  if (limit > 0 && count >= limit) {
    const name = proxy.name || (proxy.host && proxy.port ? `${proxy.host}:${proxy.port}` : proxy.raw || proxy.id || '未知代理');
    const holders = occupyingProfiles.slice(0, 3).map((p) => p.name || p.id).join('、');
    const extra = occupyingProfiles.length > 3 ? ' 等' : '';
    const reason = `代理「${name}」已分配给 ${count} 个环境，已达并发上限（${count}/${limit}）。占用环境：${holders}${extra}。无法继续分配，请先解除其他环境的绑定或提高该代理的并发上限。`;
    return {
      ok: false,
      reason,
      code: 'ERR_PROXY_MAX_CONCURRENCY',
      count,
      limit,
      proxy,
      occupyingProfiles,
    };
  }

  return {
    ok: true,
    reason: null,
    count,
    limit,
    proxy,
    occupyingProfiles,
  };
}

/**
 * Assert that a proxy has capacity to accept a new profile or switch assignment.
 * Throws a typed Error (code: ERR_PROXY_MAX_CONCURRENCY) with actionable message when capped.
 */
function assertProxyAssignmentAvailable(proxyOrId, profiles, targetOrOptions = null) {
  const result = canAssignProxy(proxyOrId, profiles, targetOrOptions);
  if (!result.ok) {
    const error = new Error(result.reason);
    error.code = result.code || 'ERR_PROXY_MAX_CONCURRENCY';
    error.proxyId = result.proxy?.id || null;
    error.limit = result.limit;
    error.count = result.count;
    error.occupyingProfiles = result.occupyingProfiles;
    throw error;
  }
  return result;
}

module.exports = {
  ProxyStore,
  normalizeProxyRecord,
  summarizeProxyUsage,
  canAssignProxy,
  assertProxyAssignmentAvailable,
  profileMatchesProxy,
  MAX_PROXY_CONCURRENCY,
};
