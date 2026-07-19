'use strict';

/**
 * OpenBrowser cloud backup / restore.
 * Providers: local file path, WebDAV, GitHub repo Contents API.
 * Payload includes profiles (cookies/password/2FA/proxy/fingerprint/prefs),
 * groups, proxy library snapshot, and optional per-profile browser data files.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');
const zlib = require('zlib');
const { assertProfileId, assertSafeProfileChild } = require('./isolation');

const BACKUP_VERSION = 1;
const REMOTE_NAME = 'openbrowser-backup.obpack';
const MAX_BACKUP_PACKAGE_BYTES = 100 * 1024 * 1024;
const MAX_BACKUP_JSON_BYTES = 120 * 1024 * 1024;
const MAX_BROWSER_DATA_BYTES = 80 * 1024 * 1024;
const MAX_REMOTE_RESPONSE_BYTES = 120 * 1024 * 1024;
const MAX_REMOTE_ERROR_BYTES = 64 * 1024;
const SAFE_GITHUB_NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const SAFE_GITHUB_BRANCH = /^[A-Za-z0-9._\/-]{1,255}$/;

function nowIso() {
  return new Date().toISOString();
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function encryptPayload(plainBuf, passphrase) {
  if (!passphrase) return { encrypted: false, data: plainBuf };
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(passphrase), salt, 32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plainBuf), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    encrypted: true,
    data: Buffer.concat([
      Buffer.from('OBE1'),
      salt,
      iv,
      tag,
      enc,
    ]),
  };
}

function decryptPayload(buf, passphrase) {
  if (buf.length >= 4 && buf.subarray(0, 4).toString() === 'OBE1') {
    if (!passphrase) throw new Error('备份已加密，请填写恢复密码');
    const salt = buf.subarray(4, 20);
    const iv = buf.subarray(20, 32);
    const tag = buf.subarray(32, 48);
    const enc = buf.subarray(48);
    const key = crypto.scryptSync(String(passphrase), salt, 32);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]);
  }
  return buf;
}

async function collectProfileDataFiles(profileRoot, profile, limits = {}) {
  const advanced = profile.advanced || {};
  const files = {};
  if (!profileRoot || !fs.existsSync(profileRoot)) return files;
  // Only pack browser data when this environment opts into cloud backup
  if (!advanced.cloudBackup) return files;
  const defaultDir = path.join(profileRoot, 'Default');
  const candidates = [];
  // Cookies always included when cloud backup is on (close-time Cookie sync)
  if (advanced.syncCookiesOnClose !== false || advanced.saveCookies !== false) {
    candidates.push(['Network/Cookies', path.join(defaultDir, 'Network', 'Cookies')]);
    candidates.push(['Network/Cookies-journal', path.join(defaultDir, 'Network', 'Cookies-journal')]);
  }
  if (advanced.syncLocalStorage) {
    candidates.push(['Local Storage', path.join(defaultDir, 'Local Storage')]);
  }
  if (advanced.syncIndexedDB) {
    candidates.push(['IndexedDB', path.join(defaultDir, 'IndexedDB')]);
  }
  if (advanced.syncPasswords) {
    candidates.push(['Login Data', path.join(defaultDir, 'Login Data')]);
    candidates.push(['Login Data-journal', path.join(defaultDir, 'Login Data-journal')]);
  }
  if (advanced.syncExtensionData) {
    candidates.push(['Local Extension Settings', path.join(defaultDir, 'Local Extension Settings')]);
    candidates.push(['Extension State', path.join(defaultDir, 'Extension State')]);
  }
  const maxFile = limits.maxFileBytes || 25 * 1024 * 1024;
  const maxTotal = limits.maxTotalBytes || 80 * 1024 * 1024;
  let total = 0;

  async function walk(rel, abs) {
    let st;
    try { st = await fsp.lstat(abs); } catch (_) { return; }
    if (st.isSymbolicLink()) return;
    if (st.isFile()) {
      if (st.size > maxFile || total + st.size > maxTotal) return;
      const buf = await fsp.readFile(abs);
      files[rel.replace(/\\/g, '/')] = buf.toString('base64');
      total += st.size;
      return;
    }
    if (!st.isDirectory()) return;
    const entries = await fsp.readdir(abs).catch(() => []);
    for (const name of entries) {
      if (name === '.' || name === '..') continue;
      await walk(path.join(rel, name), path.join(abs, name));
    }
  }

  for (const [rel, abs] of candidates) {
    await walk(rel, abs);
  }
  return files;
}

async function restoreProfileDataFiles(profileRoot, files) {
  if (!files || typeof files !== 'object') return 0;
  const base = path.resolve(profileRoot, 'Default');
  const entries = Object.entries(files);
  if (entries.length > 2000) throw new Error('备份文件数量超过安全限制');
  let count = 0;
  let totalBytes = 0;
  for (const [rel, b64] of entries) {
    if (!rel || typeof b64 !== 'string') continue;
    // Reject absolute / drive-relative paths before any normalization that strips leading slashes
    const raw = String(rel).replace(/\0/g, '');
    if (path.isAbsolute(raw) || path.win32.isAbsolute(raw) || path.posix.isAbsolute(raw)) continue;
    if (/^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith('\\\\')) continue;
    const safe = raw.replace(/^[/\\]+/, '').replace(/\\/g, '/');
    if (!safe || safe.includes('..') || safe.includes('\0')) continue;
    // Block path segments that escape after resolve (Windows separators / alternate roots)
    const abs = path.resolve(base, safe);
    if (abs !== base && !abs.startsWith(base + path.sep)) continue;
    // Extra Windows case-insensitive guard
    const absKey = process.platform === 'win32' ? abs.toLowerCase() : abs;
    const baseKey = process.platform === 'win32' ? base.toLowerCase() : base;
    if (absKey !== baseKey && !absKey.startsWith(baseKey + path.sep)) continue;
    const decoded = Buffer.from(b64, 'base64');
    if (decoded.length > 25 * 1024 * 1024) throw new Error('备份单文件超过安全限制');
    totalBytes += decoded.length;
    if (totalBytes > 80 * 1024 * 1024) throw new Error('备份文件总大小超过安全限制');
    await assertSafeProfileChild(profileRoot, abs);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await assertSafeProfileChild(profileRoot, abs);
    await fsp.writeFile(abs, decoded, { flag: 'w', mode: 0o600 });
    count += 1;
  }
  return count;
}

function profileStamp(profile) {
  const p = profile || {};
  const candidates = [p.updatedAt, p.syncedAt, p.exitCheckedAt, p.createdAt];
  for (const c of candidates) {
    const t = Date.parse(String(c || ''));
    if (Number.isFinite(t)) return t;
  }
  return 0;
}

function stripDataFiles(profile) {
  if (!profile || typeof profile !== 'object') return profile;
  const copy = { ...profile };
  delete copy._dataFiles;
  return copy;
}

/**
 * Merge remote backup into local state.
 * mode:
 *  - merge (default): keep local-only; add remote-only; same id → newer wins (timestamp), else remote config fields win
 *  - local-wins: only add missing ids from remote
 *  - remote-wins / overwrite: remote list becomes truth (still reported as merge stats)
 */
function mergeProfiles(localList = [], remoteList = [], mode = 'merge') {
  const local = Array.isArray(localList) ? localList.map(stripDataFiles) : [];
  const remote = Array.isArray(remoteList) ? remoteList.map(stripDataFiles) : [];
  const stats = { added: 0, updated: 0, kept: 0, skipped: 0, conflicts: 0 };

  if (mode === 'overwrite' || mode === 'remote-wins') {
    stats.added = remote.filter((r) => !local.some((l) => l.id === r.id)).length;
    stats.updated = remote.filter((r) => local.some((l) => l.id === r.id)).length;
    stats.kept = 0;
    return {
      profiles: remote.map((p) => ({ ...p, syncedAt: nowIso() })),
      stats: { ...stats, mode },
    };
  }

  const byId = new Map();
  for (const item of local) {
    if (item?.id) byId.set(item.id, { ...item, _source: 'local' });
  }

  for (const remoteItem of remote) {
    if (!remoteItem?.id) continue;
    const localItem = byId.get(remoteItem.id);
    if (!localItem) {
      byId.set(remoteItem.id, { ...remoteItem, syncedAt: nowIso(), _source: 'remote' });
      stats.added += 1;
      continue;
    }
    if (mode === 'local-wins') {
      stats.skipped += 1;
      continue;
    }
    // merge / newer-wins
    const localTs = profileStamp(localItem);
    const remoteTs = profileStamp(remoteItem);
    stats.conflicts += 1;
    let winner;
    if (remoteTs && localTs && remoteTs !== localTs) {
      winner = remoteTs >= localTs ? remoteItem : localItem;
    } else if (remoteTs && !localTs) {
      winner = remoteItem;
    } else if (!remoteTs && localTs) {
      winner = localItem;
    } else {
      // no timestamps: prefer remote cloud-relevant fields, keep local identity/runtime
      winner = {
        ...localItem,
        ...remoteItem,
        id: localItem.id,
        number: localItem.number || remoteItem.number,
        name: localItem.name || remoteItem.name,
        // cookies/platform/proxy from remote if present
        cookies: remoteItem.cookies != null && remoteItem.cookies !== '' ? remoteItem.cookies : localItem.cookies,
        platform: remoteItem.platform || localItem.platform,
        proxy: remoteItem.proxy != null ? remoteItem.proxy : localItem.proxy,
        proxyMeta: { ...(localItem.proxyMeta || {}), ...(remoteItem.proxyMeta || {}) },
        privacy: { ...(localItem.privacy || {}), ...(remoteItem.privacy || {}) },
        advanced: { ...(localItem.advanced || {}), ...(remoteItem.advanced || {}) },
      };
    }
    const fromRemote = winner === remoteItem || winner.cookies === remoteItem.cookies;
    byId.set(remoteItem.id, {
      ...stripDataFiles(winner),
      syncedAt: nowIso(),
      updatedAt: winner.updatedAt || nowIso(),
      _mergedFrom: fromRemote ? 'remote' : 'local',
    });
    stats.updated += 1;
  }

  for (const item of byId.values()) {
    if (item._source === 'local' && !remote.some((r) => r.id === item.id)) stats.kept += 1;
    delete item._source;
    delete item._mergedFrom;
  }

  return {
    profiles: [...byId.values()],
    stats: { ...stats, mode: mode || 'merge' },
  };
}

function mergeGroups(localGroups = [], remoteGroups = [], mode = 'merge') {
  if (mode === 'overwrite' || mode === 'remote-wins') return Array.isArray(remoteGroups) ? remoteGroups : [];
  const map = new Map();
  for (const g of localGroups || []) if (g?.id) map.set(g.id, g);
  for (const g of remoteGroups || []) {
    if (!g?.id) continue;
    if (mode === 'local-wins' && map.has(g.id)) continue;
    map.set(g.id, { ...(map.get(g.id) || {}), ...g });
  }
  return [...map.values()];
}

function mergeProxies(localProxies = [], remoteProxies = [], mode = 'merge') {
  if (mode === 'overwrite' || mode === 'remote-wins') return Array.isArray(remoteProxies) ? remoteProxies : [];
  const map = new Map();
  const keyOf = (p) => p.id || `${p.protocol || ''}:${p.host || ''}:${p.port || ''}`;
  for (const p of localProxies || []) map.set(keyOf(p), p);
  for (const p of remoteProxies || []) {
    const k = keyOf(p);
    if (mode === 'local-wins' && map.has(k)) continue;
    map.set(k, { ...(map.get(k) || {}), ...p });
  }
  return [...map.values()];
}

function profileRemoteName(id) {
  const safe = assertProfileId(id);
  return `profiles/openbrowser-profile-${safe}.obpack`;
}

function safeRemotePath(value, fallback = '') {
  const raw = String(value || fallback).trim().replace(/\\/g, '/');
  if (!raw || raw.includes('\0') || raw.startsWith('/') || /^[A-Za-z]:\//.test(raw)) throw new Error('远程备份路径无效');
  const parts = raw.split('/').filter(Boolean);
  if (!parts.length || parts.some((part) => part === '.' || part === '..' || part.length > 160)) {
    throw new Error('远程备份路径包含不安全片段');
  }
  return parts.join('/');
}

function safeLocalTarget(root, remoteName) {
  const base = path.resolve(String(root || ''));
  const rel = safeRemotePath(remoteName, REMOTE_NAME);
  const target = path.resolve(base, ...rel.split('/'));
  const normalize = (value) => process.platform === 'win32' ? value.toLowerCase() : value;
  if (normalize(target) === normalize(base) || !normalize(target).startsWith(normalize(base) + path.sep)) {
    throw new Error('本地备份路径越过所选目录');
  }
  return { base, rel, target };
}

async function assertSafeLocalTarget(base, target) {
  try {
    if ((await fsp.lstat(base)).isSymbolicLink()) throw new Error('本地备份根目录不能是符号链接或 junction');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  let current = base;
  for (const part of path.relative(base, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      if ((await fsp.lstat(current)).isSymbolicLink()) throw new Error('本地备份路径包含符号链接或 junction');
    } catch (error) {
      if (error.code === 'ENOENT') break;
      throw error;
    }
  }
}

function withRemoteName(config, provider, remoteName) {
  const c = { ...(config || {}) };
  const name = remoteName || REMOTE_NAME;
  if (String(provider) === 'github') {
    const base = safeRemotePath(c.path, `openbrowser/${REMOTE_NAME}`);
    const safeName = safeRemotePath(name, REMOTE_NAME);
    if (name === REMOTE_NAME) {
      c.path = base;
    } else {
      const dir = base.includes('/') ? base.replace(/\/[^/]+$/, '') : 'openbrowser';
      c.path = `${dir}/${safeName}`;
    }
  }
  return c;
}

function validatedGitHubConfig(config, remoteName) {
  const cfg = withRemoteName(config, 'github', remoteName);
  const owner = String(cfg.owner || '').trim();
  const repo = String(cfg.repo || '').trim();
  const token = String(cfg.token || '').trim();
  const branch = String(cfg.branch || 'main').trim() || 'main';
  const filePath = safeRemotePath(cfg.path, `openbrowser/${remoteName}`);
  if (!SAFE_GITHUB_NAME.test(owner) || !SAFE_GITHUB_NAME.test(repo) || !token) throw new Error('GitHub owner / repo / token 无效');
  if (!SAFE_GITHUB_BRANCH.test(branch) || branch.includes('..') || branch.startsWith('/') || branch.endsWith('/')) {
    throw new Error('GitHub branch 无效');
  }
  if (token.length > 1024) throw new Error('GitHub token 长度无效');
  return { owner, repo, token, branch, filePath };
}

async function buildBackupPackage({
  profiles = [],
  groups = [],
  proxies = [],
  settings = {},
  profileDataRoot,
  includeBrowserData = true,
  passphrase = '',
  profileIds = null,
}) {
  let list = Array.isArray(profiles) ? profiles : [];
  if (Array.isArray(profileIds) && profileIds.length) {
    const allow = new Set(profileIds.map(String));
    list = list.filter((p) => allow.has(String(p.id)));
  }
  // default: only environments that explicitly enable cloudBackup (ix/Hub per-profile opt-in)
  if (!Array.isArray(profileIds)) {
    list = list.filter((p) => Boolean(p?.advanced?.cloudBackup));
  }
  const packedProfiles = [];
  let browserDataBytes = 0;
  let estimatedJsonBytes = 0;
  for (const profile of list) {
    assertProfileId(profile?.id);
    const item = { ...profile, updatedAt: profile.updatedAt || nowIso() };
    if (includeBrowserData && profileDataRoot && profile?.id) {
      const root = path.join(profileDataRoot, profile.id);
      item._dataFiles = await collectProfileDataFiles(root, profile, {
        maxTotalBytes: Math.max(0, MAX_BROWSER_DATA_BYTES - browserDataBytes),
      });
      for (const encoded of Object.values(item._dataFiles)) {
        browserDataBytes += Math.floor(String(encoded).length * 3 / 4);
      }
    }
    estimatedJsonBytes += Buffer.byteLength(JSON.stringify(item));
    if (estimatedJsonBytes > MAX_BACKUP_JSON_BYTES) throw new Error('备份配置内容超过 120 MB 安全限制');
    packedProfiles.push(item);
  }
  const body = {
    version: BACKUP_VERSION,
    soft: 'OpenBrowser',
    createdAt: nowIso(),
    profiles: packedProfiles,
    groups,
    proxies,
    settings,
  };
  const json = Buffer.from(JSON.stringify(body), 'utf8');
  if (json.length > MAX_BACKUP_JSON_BYTES) throw new Error('备份内容超过 120 MB 安全限制');
  const gz = zlib.gzipSync(json, { level: 9 });
  const { encrypted, data } = encryptPayload(gz, passphrase);
  return {
    buffer: data,
    meta: {
      version: BACKUP_VERSION,
      encrypted,
      createdAt: body.createdAt,
      profileCount: packedProfiles.length,
      profileIds: packedProfiles.map((p) => p.id),
      bytes: data.length,
      sha256: sha256(data),
    },
  };
}

async function parseBackupPackage(buffer, passphrase = '') {
  const raw = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (raw.length > MAX_BACKUP_PACKAGE_BYTES) throw new Error('备份包超过 100 MB 安全限制');
  const decrypted = decryptPayload(raw, passphrase);
  if (decrypted.length > MAX_BACKUP_PACKAGE_BYTES) throw new Error('备份包解密后超过安全限制');
  let jsonBuf;
  try {
    jsonBuf = zlib.gunzipSync(decrypted, { maxOutputLength: MAX_BACKUP_JSON_BYTES });
  } catch (_) {
    jsonBuf = decrypted;
  }
  if (jsonBuf.length > MAX_BACKUP_JSON_BYTES) throw new Error('备份内容超过 120 MB 安全限制');
  const body = JSON.parse(jsonBuf.toString('utf8'));
  if (!body || !Array.isArray(body.profiles)) throw new Error('备份格式无效');
  return body;
}

function request(urlString, options = {}, body) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (handler, value) => {
      if (settled) return;
      settled = true;
      handler(value);
    };
    const u = new URL(urlString);
    const lib = u.protocol === 'http:' ? http : https;
    const maxBytes = Number(options.maxBytes) || MAX_REMOTE_RESPONSE_BYTES;
    if (body && body.length > MAX_REMOTE_RESPONSE_BYTES * 2) return reject(new Error('上传内容超过安全限制'));
    const req = lib.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search,
      method: options.method || 'GET',
      headers: options.headers || {},
      timeout: options.timeout || 60000,
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('error', (error) => finish(reject, error));
      res.on('data', (c) => {
        if (settled) return;
        size += c.length;
        if (size > maxBytes) {
          const error = new Error('远程响应超过安全限制');
          finish(reject, error);
          res.destroy(error);
          req.destroy(error);
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => {
        if (settled) return;
        const buf = Buffer.concat(chunks);
        finish(resolve, { status: res.statusCode || 0, headers: res.headers, body: buf });
      });
    });
    req.on('error', (error) => finish(reject, error));
    req.on('timeout', () => { req.destroy(new Error('request timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

function basicAuth(user, pass) {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

async function ensureWebDavDir(baseUrl, user, pass, relativeDir) {
  const parts = relativeDir.split('/').filter(Boolean);
  let cur = baseUrl.replace(/\/?$/, '/');
  for (const part of parts) {
    cur += encodeURIComponent(part) + '/';
    const res = await request(cur, {
      method: 'MKCOL',
      headers: { Authorization: basicAuth(user, pass) },
    });
    if (![201, 204, 405, 301, 302, 409].includes(res.status)) {
      // 409/405 often mean exists
      if (res.status >= 400 && res.status !== 405 && res.status !== 409) {
        throw new Error(`WebDAV MKCOL 失败 (${res.status})`);
      }
    }
  }
}

function webDavTarget(config, remoteName = REMOTE_NAME) {
  let parsed;
  try { parsed = new URL(String(config.url || '')); } catch (_) { throw new Error('请填写有效的 WebDAV 地址'); }
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname.toLowerCase());
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    throw new Error('WebDAV 必须使用 HTTPS；仅本机回环地址允许 HTTP');
  }
  if (parsed.username || parsed.password) throw new Error('WebDAV 凭据必须使用独立账号字段');
  if (parsed.search) throw new Error('WebDAV 地址不能包含查询参数');
  parsed.hash = '';
  const base = parsed.toString().replace(/\/?$/, '/');
  const dir = safeRemotePath(config.dir, 'OpenBrowser');
  const name = safeRemotePath(remoteName, REMOTE_NAME);
  const rel = [dir, name].filter(Boolean).join('/');
  const encoded = rel.split('/').filter(Boolean).map(encodeURIComponent).join('/');
  return { base, dir, name, rel, target: base + encoded };
}

async function uploadWebDav(config, buffer, remoteName = REMOTE_NAME) {
  const user = String(config.username || '');
  const pass = String(config.password || '');
  const { base, rel, target } = webDavTarget(config, remoteName);
  if (!base || base === '/') throw new Error('请填写 WebDAV 地址');
  const parent = rel.includes('/') ? rel.replace(/\/[^/]+$/, '') : '';
  if (parent) await ensureWebDavDir(base, user, pass, parent);
  const res = await request(target, {
    method: 'PUT',
    headers: {
      Authorization: basicAuth(user, pass),
      'Content-Type': 'application/octet-stream',
      'Content-Length': buffer.length,
    },
  }, buffer);
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`WebDAV 上传失败 (${res.status})`);
  }
  return { provider: 'webdav', url: target, bytes: buffer.length, remoteName };
}

async function downloadWebDav(config, remoteName = REMOTE_NAME) {
  const user = String(config.username || '');
  const pass = String(config.password || '');
  const { target } = webDavTarget(config, remoteName);
  const res = await request(target, {
    method: 'GET',
    headers: { Authorization: basicAuth(user, pass) },
  });
  if (res.status !== 200) {
    throw new Error(`WebDAV 下载失败 (${res.status})`);
  }
  return res.body;
}

async function uploadGitHub(config, buffer, remoteName = REMOTE_NAME) {
  const { owner, repo, token, branch, filePath } = validatedGitHubConfig(config, remoteName);
  const apiBase = `https://api.github.com/repos/${owner}/${repo}/contents/${filePath.split('/').map(encodeURIComponent).join('/')}`;
  let sha;
  const getRes = await request(`${apiBase}?ref=${encodeURIComponent(branch)}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'OpenBrowser-CloudSync',
    },
    maxBytes: MAX_REMOTE_ERROR_BYTES,
  });
  if (getRes.status === 200) {
    try { sha = JSON.parse(getRes.body.toString('utf8')).sha; } catch (_) {}
  }
  const payload = JSON.stringify({
    message: `OpenBrowser backup ${nowIso()} · ${remoteName}`,
    content: buffer.toString('base64'),
    branch,
    ...(sha ? { sha } : {}),
  });
  const putRes = await request(apiBase, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'OpenBrowser-CloudSync',
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    },
    maxBytes: MAX_REMOTE_ERROR_BYTES,
  }, Buffer.from(payload));
  if (putRes.status < 200 || putRes.status >= 300) {
    throw new Error(`GitHub 上传失败 (${putRes.status})`);
  }
  return { provider: 'github', owner, repo, path: filePath, bytes: buffer.length, remoteName };
}

async function downloadGitHub(config, remoteName = REMOTE_NAME) {
  const { owner, repo, token, branch, filePath } = validatedGitHubConfig(config, remoteName);
  const apiBase = `https://api.github.com/repos/${owner}/${repo}/contents/${filePath.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(branch)}`;
  const res = await request(apiBase, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'OpenBrowser-CloudSync',
    },
    maxBytes: MAX_REMOTE_RESPONSE_BYTES,
  });
  if (res.status !== 200) throw new Error(`GitHub 下载失败 (${res.status})`);
  const json = JSON.parse(res.body.toString('utf8'));
  if (!json.content) throw new Error('GitHub 文件内容为空');
  const decoded = Buffer.from(String(json.content).replace(/\n/g, ''), 'base64');
  if (decoded.length > MAX_BACKUP_PACKAGE_BYTES) throw new Error('GitHub 备份超过安全限制');
  return decoded;
}

/** Google Drive via "application data" style: user provides WebDAV-compatible endpoint or API key is not enough.
 *  We support "gdrive" as alias that expects a WebDAV bridge URL (Alist / rclone serve).
 */
async function uploadGoogleCloud(config, buffer, remoteName = REMOTE_NAME) {
  // Prefer WebDAV bridge fields; fall back to generic webdav keys.
  return uploadWebDav({
    url: config.url || config.webdavUrl,
    username: config.username || config.user || '',
    password: config.password || config.token || '',
    dir: config.dir || 'OpenBrowser',
  }, buffer, remoteName);
}

async function downloadGoogleCloud(config, remoteName = REMOTE_NAME) {
  return downloadWebDav({
    url: config.url || config.webdavUrl,
    username: config.username || config.user || '',
    password: config.password || config.token || '',
    dir: config.dir || 'OpenBrowser',
  }, remoteName);
}

async function uploadLocal(config, buffer, remoteName = REMOTE_NAME) {
  const dir = String(config.dir || '').trim();
  if (!dir) throw new Error('请选择本地备份目录');
  const { base, rel, target: file } = safeLocalTarget(dir, remoteName);
  await assertSafeLocalTarget(base, file);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await assertSafeLocalTarget(base, file);
  await fsp.writeFile(file, buffer, { mode: 0o600 });
  if (rel === REMOTE_NAME || !rel.includes('/')) {
    const stamp = nowIso().replace(/[:.]/g, '-');
    await fsp.writeFile(path.join(base, `openbrowser-backup-${stamp}.obpack`), buffer, { mode: 0o600 }).catch(() => {});
  }
  return { provider: 'local', path: file, bytes: buffer.length, remoteName: rel };
}

async function downloadLocal(config, remoteName = REMOTE_NAME) {
  const dir = String(config.dir || '').trim();
  if (!dir) throw new Error('请选择本地备份目录');
  const { base, target: file } = safeLocalTarget(dir, remoteName);
  await assertSafeLocalTarget(base, file);
  return fsp.readFile(file);
}

/** WebDAV-bridge providers: Alist / OpenList / rclone serve for consumer clouds */
const WEBDAV_BRIDGE_PROVIDERS = new Set([
  'gdrive', 'google', 'gcs',
  'onedrive', 'microsoft', 'mscloud',
  'quark', 'kuake',
  'baidu', 'baiduyun', 'pan',
]);

function isWebDavBridgeProvider(provider) {
  return WEBDAV_BRIDGE_PROVIDERS.has(String(provider || '').toLowerCase());
}

async function upload(provider, config, buffer, remoteName = REMOTE_NAME) {
  const key = String(provider || 'local').toLowerCase();
  switch (key) {
    case 'webdav': return uploadWebDav(config, buffer, remoteName);
    case 'github': return uploadGitHub(config, buffer, remoteName);
    case 'local':
      return uploadLocal(config, buffer, remoteName);
    default:
      if (isWebDavBridgeProvider(key)) return uploadGoogleCloud(config, buffer, remoteName);
      return uploadLocal(config, buffer, remoteName);
  }
}

async function download(provider, config, remoteName = REMOTE_NAME) {
  const key = String(provider || 'local').toLowerCase();
  switch (key) {
    case 'webdav': return downloadWebDav(config, remoteName);
    case 'github': return downloadGitHub(config, remoteName);
    case 'local':
      return downloadLocal(config, remoteName);
    default:
      if (isWebDavBridgeProvider(key)) return downloadGoogleCloud(config, remoteName);
      return downloadLocal(config, remoteName);
  }
}

function emptyWebDavBridge() {
  return { url: '', username: '', password: '', dir: 'OpenBrowser' };
}

function defaultCloudConfig() {
  return {
    enabled: false,
    autoSyncOnQuit: true,
    includeBrowserData: true,
    provider: 'local',
    passphrase: '',
    restoreMode: 'merge',
    lastSyncAt: '',
    lastError: '',
    local: { dir: '' },
    webdav: emptyWebDavBridge(),
    github: { owner: '', repo: '', token: '', branch: 'main', path: 'openbrowser/openbrowser-backup.obpack' },
    gdrive: emptyWebDavBridge(),
    onedrive: emptyWebDavBridge(),
    quark: emptyWebDavBridge(),
    baidu: emptyWebDavBridge(),
  };
}

/** One-click presets shown in 本地设置 → 云同步 */
function cloudPresets() {
  return {
    onedrive: {
      id: 'onedrive',
      label: '微软云 OneDrive',
      provider: 'onedrive',
      dir: 'OpenBrowser',
      urlPlaceholder: 'https://你的域名/dav/onedrive',
      hint: '推荐用 Alist / OpenList 挂载 OneDrive，再填 WebDAV 地址。示例：https://alist.example.com/dav/onedrive 。用户名为 Alist 账号，密码为 Alist 密码或令牌。',
    },
    quark: {
      id: 'quark',
      label: '夸克云',
      provider: 'quark',
      dir: 'OpenBrowser',
      urlPlaceholder: 'https://你的域名/dav/quark',
      hint: '夸克无官方 WebDAV，请用 Alist / OpenList 挂载夸克网盘后填入桥接地址。Cookie 登录配置在 Alist 后台完成，此处只填 WebDAV 账号。',
    },
    baidu: {
      id: 'baidu',
      label: '百度云',
      provider: 'baidu',
      dir: 'OpenBrowser',
      urlPlaceholder: 'https://你的域名/dav/baidu',
      hint: '百度网盘请用 Alist / OpenList 挂载后使用 WebDAV。示例路径：/dav/baidu 或 /dav/百度网盘 。远程目录建议填 OpenBrowser。',
    },
  };
}

module.exports = {
  BACKUP_VERSION,
  REMOTE_NAME,
  defaultCloudConfig,
  cloudPresets,
  isWebDavBridgeProvider,
  WEBDAV_BRIDGE_PROVIDERS,
  buildBackupPackage,
  parseBackupPackage,
  restoreProfileDataFiles,
  mergeProfiles,
  mergeGroups,
  mergeProxies,
  profileRemoteName,
  profileStamp,
  withRemoteName,
  upload,
  download,
  encryptPayload,
  decryptPayload,
  safeRemotePath,
  safeLocalTarget,
  webDavTarget,
  validatedGitHubConfig,
};
