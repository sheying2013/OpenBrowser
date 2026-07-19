'use strict';

const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { parseProxy, displayProxy } = require('../proxy-forwarder');

/**
 * Local proxy library (proxy-list CRUD, self-contained).
 */

function uid() {
  return crypto.randomBytes(8).toString('hex');
}

function normalizeProxyRecord(input = {}, existing = null) {
  const name = String(input.name || existing?.name || '').trim().slice(0, 120);
  const remark = String(input.remark || existing?.remark || '').slice(0, 500);
  const protocol = String(input.protocol || input.type || existing?.protocol || 'socks5').toLowerCase();
  const host = String(input.host || existing?.host || '').trim();
  const port = Number(input.port ?? existing?.port);
  const username = String(input.username ?? input.user ?? existing?.username ?? '');
  const password = String(input.password ?? existing?.password ?? '');
  const refreshUrl = String(input.refreshUrl || input.refresh_url || existing?.refreshUrl || '').slice(0, 1000);
  const ipChannel = ['ip-api', 'ip2location'].includes(String(input.ipChannel || existing?.ipChannel || ''))
    ? String(input.ipChannel || existing?.ipChannel)
    : 'ip-api';

  let raw = String(input.raw || input.proxy || '').trim();
  if (!raw) {
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('主机和端口必填');
    }
    const auth = username ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@` : '';
    raw = `${protocol}://${auth}${host}:${port}`;
  }

  const parsed = parseProxy(raw);
  if (!parsed) throw new Error('当前记录是直连，请填写代理地址');

  const now = new Date().toISOString();
  return {
    id: existing?.id || String(input.id || uid()),
    name: name || `${parsed.protocol.toUpperCase()} ${parsed.host}:${parsed.port}`,
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
    remark,
    lastCheck: existing?.lastCheck || null,
    lastIp: existing?.lastIp || '',
    lastCountryCode: existing?.lastCountryCode || '',
    create_time: existing?.create_time || now,
    update_time: now,
  };
}

class ProxyStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = { version: 1, items: [] };
  }

  async load() {
    try {
      const raw = await fsp.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      this.data = {
        version: 1,
        items: Array.isArray(parsed.items) ? parsed.items : [],
      };
    } catch (_) {
      await this.save();
    }
    return this.data;
  }

  async save() {
    await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = this.filePath + '.tmp';
    await fsp.writeFile(temporary, JSON.stringify(this.data, null, 2), 'utf8');
    await fsp.rm(this.filePath, { force: true });
    await fsp.rename(temporary, this.filePath);
  }

  list(filter = {}) {
    let items = [...this.data.items];
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
    return this.data.items.find((item) => item.id === id) || null;
  }

  async create(input) {
    const record = normalizeProxyRecord(input);
    if (this.data.items.length >= 5000) throw new Error('代理数量已达上限 5000');
    this.data.items.unshift(record);
    await this.save();
    return record;
  }

  async createMany(list = []) {
    if (!Array.isArray(list) || !list.length) throw new Error('请提供代理数组');
    if (list.length > 500) throw new Error('单次最多导入 500 条');
    if (this.data.items.length + list.length > 5000) throw new Error('代理数量已达上限 5000');
    // Validate every entry before mutating storage, then commit once.
    const created = list.map((item) => normalizeProxyRecord(item));
    this.data.items.unshift(...created);
    await this.save();
    return created;
  }

  async update(id, input) {
    const existing = this.get(id);
    if (!existing) throw new Error('代理不存在: ' + id);
    const next = normalizeProxyRecord({ ...input, id }, existing);
    const index = this.data.items.findIndex((item) => item.id === id);
    this.data.items[index] = next;
    await this.save();
    return next;
  }

  async remove(ids) {
    const set = new Set((Array.isArray(ids) ? ids : [ids]).map(String));
    const before = this.data.items.length;
    this.data.items = this.data.items.filter((item) => !set.has(item.id));
    await this.save();
    return { deleted: before - this.data.items.length, ids: [...set] };
  }

  async markCheck(id, result = {}) {
    const item = this.get(id);
    if (!item) throw new Error('代理不存在: ' + id);
    item.lastCheck = new Date().toISOString();
    item.lastIp = String(result.ip || '');
    item.lastCountryCode = String(result.countryCode || result.country_code || '');
    item.update_time = item.lastCheck;
    await this.save();
    return item;
  }

  toChromeString(id) {
    const item = this.get(id);
    if (!item) return null;
    return item.raw;
  }

  display(item) {
    return displayProxy(item.raw);
  }
}

module.exports = { ProxyStore, normalizeProxyRecord };
