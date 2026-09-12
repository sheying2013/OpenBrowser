'use strict';

/**
 * DNS-over-HTTPS resolver (RFC 8484 wire format).
 *
 * Zero-dependency implementation: encodes DNS query packets, decodes response
 * packets for common record types, and caches answers honoring record TTL.
 * Multiple endpoints are tried in randomized order with a per-query timeout,
 * so a single unreachable endpoint cannot stall resolution.
 */

const dns = require('dns');
const net = require('net');

const DEFAULT_ENDPOINTS = [
  'https://cloudflare-dns.com/dns-query',
  'https://dns.google/dns-query',
];

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_CACHE = 500;

const TYPE_BY_NAME = {
  A: 1, NS: 2, CNAME: 5, SOA: 6, PTR: 12, MX: 15, TXT: 16,
  AAAA: 28, SRV: 33, HTTPS: 65,
};
const NAME_BY_TYPE = Object.fromEntries(
  Object.entries(TYPE_BY_NAME).map(([k, v]) => [v, k])
);

const CLASS_IN = 1;

/** RFC 1035 label limits: 63 octets per label, 255 octets per name. */
const MAX_LABEL_LENGTH = 63;
const MAX_NAME_LENGTH = 255;

const TEXT_DECODER = new TextDecoder('utf-8', { fatal: false });

function randomId() {
  return 1 + Math.floor(Math.random() * 65534);
}

function shuffle(list) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

function encodeName(name) {
  const normalized = String(name || '').replace(/\.$/, '');
  if (!normalized) return Buffer.from([0]);
  if (normalized.length > MAX_NAME_LENGTH) {
    throw new Error('dns name too long');
  }
  const chunks = [];
  for (const label of normalized.split('.')) {
    if (!label) continue;
    const bytes = Buffer.from(label, 'utf8');
    if (bytes.length > MAX_LABEL_LENGTH) {
      throw new Error('dns label too long');
    }
    chunks.push(Buffer.from([bytes.length]));
    chunks.push(bytes);
  }
  chunks.push(Buffer.from([0]));
  return Buffer.concat(chunks);
}

/** Build a standard recursive query packet for one question. */
function encodeQuery(hostname, typeName = 'A', id = randomId()) {
  const type = TYPE_BY_NAME[String(typeName).toUpperCase()];
  if (!type) throw new Error(`unsupported dns type: ${typeName}`);

  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(0x0100, 2); // RD=1
  header.writeUInt16BE(1, 4); // qdcount
  header.writeUInt16BE(0, 6); // ancount
  header.writeUInt16BE(0, 8); // nscount
  header.writeUInt16BE(0, 10); // arcount

  const question = Buffer.concat([
    encodeName(hostname),
    Buffer.from([(type >> 8) & 0xff, type & 0xff]),
    Buffer.from([(CLASS_IN >> 8) & 0xff, CLASS_IN & 0xff]),
  ]);

  return Buffer.concat([header, question]);
}

/**
 * Read a (possibly compressed) domain name starting at `offset`.
 * Returns the decoded name plus the offset just past the name in the
 * original stream, which is what the caller needs to continue parsing.
 */
function readName(buf, offset) {
  const labels = [];
  let pos = offset;
  let jumped = false;
  let consumed = offset;
  let hops = 0;

  while (pos < buf.length) {
    const len = buf[pos];
    if (len === 0) {
      pos += 1;
      if (!jumped) consumed = pos;
      break;
    }
    // Compression pointer: top two bits set.
    if ((len & 0xc0) === 0xc0) {
      if (pos + 1 >= buf.length) throw new Error('truncated dns pointer');
      const target = ((len & 0x3f) << 8) | buf[pos + 1];
      if (!jumped) consumed = pos + 2;
      jumped = true;
      hops += 1;
      if (hops > 32) throw new Error('dns pointer loop');
      if (target >= buf.length) throw new Error('dns pointer out of range');
      pos = target;
      continue;
    }
    if ((len & 0xc0) !== 0) throw new Error('reserved dns label type');
    pos += 1;
    if (pos + len > buf.length) throw new Error('truncated dns label');
    labels.push(buf.slice(pos, pos + len).toString('utf8'));
    pos += len;
    if (!jumped) consumed = pos;
  }

  return { name: labels.join('.'), next: consumed };
}

function readTxtRdata(buf, start, length) {
  const parts = [];
  let pos = start;
  const end = start + length;
  while (pos < end) {
    const len = buf[pos];
    pos += 1;
    if (pos + len > end) break;
    parts.push(TEXT_DECODER.decode(buf.slice(pos, pos + len)));
    pos += len;
  }
  return parts.join('');
}

function decodeRdata(buf, type, rdataStart, rdlength, packet) {
  const end = rdataStart + rdlength;
  switch (type) {
    case TYPE_BY_NAME.A:
      if (rdlength !== 4) return null;
      return `${buf[rdataStart]}.${buf[rdataStart + 1]}.${buf[rdataStart + 2]}.${buf[rdataStart + 3]}`;
    case TYPE_BY_NAME.AAAA: {
      if (rdlength !== 16) return null;
      const groups = [];
      for (let i = 0; i < 16; i += 2) {
        groups.push(buf.readUInt16BE(rdataStart + i).toString(16));
      }
      return groups.join(':');
    }
    case TYPE_BY_NAME.CNAME:
    case TYPE_BY_NAME.NS:
    case TYPE_BY_NAME.PTR:
      return readName(buf, rdataStart).name;
    case TYPE_BY_NAME.TXT:
      return readTxtRdata(buf, rdataStart, rdlength);
    case TYPE_BY_NAME.MX: {
      const pref = buf.readUInt16BE(rdataStart);
      const exchange = readName(buf, rdataStart + 2).name;
      return { preference: pref, exchange };
    }
    case TYPE_BY_NAME.SRV: {
      const priority = buf.readUInt16BE(rdataStart);
      const weight = buf.readUInt16BE(rdataStart + 2);
      const port = buf.readUInt16BE(rdataStart + 4);
      const target = readName(buf, rdataStart + 6).name;
      return { priority, weight, port, target };
    }
    case TYPE_BY_NAME.SOA: {
      const primary = readName(buf, rdataStart);
      const responsible = readName(buf, primary.next);
      let pos = responsible.next;
      const serial = buf.readUInt32BE(pos); pos += 4;
      const refresh = buf.readUInt32BE(pos); pos += 4;
      const retry = buf.readUInt32BE(pos); pos += 4;
      const expire = buf.readUInt32BE(pos); pos += 4;
      const minimum = buf.readUInt32BE(pos);
      return { primary: primary.name, responsible: responsible.name, serial, refresh, retry, expire, minimum };
    }
    case TYPE_BY_NAME.HTTPS: {
      // SvcPriority + TargetName + SvcParams (opaque); surface the first two.
      const priority = buf.readUInt16BE(rdataStart);
      const target = readName(buf, rdataStart + 2).name;
      return { priority, target };
    }
    default: {
      if (end > packet.length) return null;
      return packet.slice(rdataStart, end).toString('hex');
    }
  }
}

/**
 * Decode a DNS response packet into header flags and answer records.
 * Unknown record types are preserved as hex so callers can still detect them.
 */
function decodeResponse(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) {
    throw new Error('dns response too short');
  }
  const id = buf.readUInt16BE(0);
  const flags = buf.readUInt16BE(2);
  const rcode = flags & 0x000f;
  const qdcount = buf.readUInt16BE(4);
  const ancount = buf.readUInt16BE(6);

  let pos = 12;
  const questions = [];
  for (let i = 0; i < qdcount; i += 1) {
    const q = readName(buf, pos);
    pos = q.next;
    const qtype = buf.readUInt16BE(pos);
    const qclass = buf.readUInt16BE(pos + 2);
    pos += 4;
    questions.push({ name: q.name, type: NAME_BY_TYPE[qtype] || qtype, class: qclass });
  }

  const answers = [];
  for (let i = 0; i < ancount; i += 1) {
    if (pos + 10 > buf.length) break;
    const owner = readName(buf, pos);
    pos = owner.next;
    const type = buf.readUInt16BE(pos);
    const cls = buf.readUInt16BE(pos + 2);
    const ttl = buf.readUInt32BE(pos + 4);
    const rdlength = buf.readUInt16BE(pos + 8);
    const rdataStart = pos + 10;
    if (rdataStart + rdlength > buf.length) break;
    const data = decodeRdata(buf, type, rdataStart, rdlength, buf);
    answers.push({
      name: owner.name,
      type: NAME_BY_TYPE[type] || type,
      ttl,
      class: cls,
      data,
    });
    pos = rdataStart + rdlength;
  }

  return {
    id,
    rcode,
    truncated: (flags & 0x0200) !== 0,
    questions,
    answers,
  };
}

/** Minimal TTL cache with lazy expiry and a hard entry cap. */
class TtlCache {
  constructor(max = DEFAULT_MAX_CACHE) {
    this.max = Math.max(1, Number(max) || DEFAULT_MAX_CACHE);
    this.entries = new Map();
  }

  get(key) {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    // Refresh recency for the FIFO/LRU-ish eviction below.
    this.entries.delete(key);
    this.entries.set(key, hit);
    return hit.value;
  }

  set(key, value, ttlSeconds) {
    const ttl = Number.isFinite(ttlSeconds) && ttlSeconds > 0 ? ttlSeconds : 60;
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: Date.now() + ttl * 1000 });
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value;
      this.entries.delete(oldest);
    }
  }

  clear() {
    this.entries.clear();
  }

  get size() {
    return this.entries.size;
  }
}

/**
 * Pick the last usable IP from a list of answers.
 *
 * Resolution can return several records, and an attempt to use a dead one is
 * wasted; callers conventionally take the final entry. Non-IP entries (for
 * example a CNAME leftover) are skipped.
 *
 * @param {string[]} answers
 * @returns {string|null}
 */
function getIpFromAnswer(answers) {
  if (!Array.isArray(answers)) return null;
  for (let i = answers.length - 1; i >= 0; i -= 1) {
    const candidate = answers[i];
    if (typeof candidate === 'string' && net.isIP(candidate)) return candidate;
  }
  return null;
}

/** Whether a URL already carries a scheme or is protocol-relative. */
function isAbsoluteUrl(url) {
  return /^([a-z][a-z\d+\-.]*:)?\/\//i.test(String(url || ''));
}

/** Join a base URL with a relative path, normalising the separator. */
function combineUrls(baseUrl, relativeUrl) {
  if (!relativeUrl) return baseUrl;
  return `${String(baseUrl).replace(/\/?\/$/, '')}/${String(relativeUrl).replace(/^\/+/, '')}`;
}

/**
 * Resolve `requestedUrl` against `baseUrl` when it is relative.
 * Mirrors the behaviour callers expect from an HTTP client's path building.
 */
function buildFullPath(baseUrl, requestedUrl) {
  if (baseUrl && !isAbsoluteUrl(requestedUrl)) return combineUrls(baseUrl, requestedUrl);
  return requestedUrl;
}

function base64UrlEncode(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

class DohResolver {
  /**
   * @param {object} [options]
   * @param {string[]} [options.endpoints] DoH endpoints, tried in random order.
   * @param {number} [options.timeoutMs] Per-query timeout.
   * @param {number} [options.maxCache] Maximum cached records.
   * @param {Function} [options.fetchImpl] Injectable fetch (testing / custom transport).
   * @param {Function} [options.onError] Called with (endpoint, error) on failure.
   */
  constructor(options = {}) {
    this.endpoints = Array.isArray(options.endpoints) && options.endpoints.length
      ? options.endpoints.slice()
      : DEFAULT_ENDPOINTS.slice();
    this.timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS;
    this.cache = new TtlCache(options.maxCache);
    this.textCache = new TtlCache(options.maxCache);
    this.fetchImpl = options.fetchImpl || null;
    this.onError = typeof options.onError === 'function' ? options.onError : null;
    this.controllers = new Set();
    this._fetchPromise = null;
  }

  async _fetch() {
    if (this.fetchImpl) return this.fetchImpl;
    if (!this._fetchPromise) {
      this._fetchPromise = import('undici').then((mod) => mod.fetch).catch(() => globalThis.fetch);
    }
    return this._fetchPromise;
  }

  /** Abort every query currently in flight. */
  cancel() {
    for (const controller of this.controllers) {
      try { controller.abort(); } catch (_) { /* already settled */ }
    }
  }

  getEndpoints() {
    return this.endpoints.slice();
  }

  setEndpoints(endpoints) {
    if (Array.isArray(endpoints) && endpoints.length) {
      this.endpoints = endpoints.slice();
    }
  }

  clearCache() {
    this.cache.clear();
    this.textCache.clear();
  }

  _note(endpoint, err) {
    if (this.onError) {
      try { this.onError(endpoint, err); } catch (_) { /* listener must not break resolution */ }
    }
  }

  buildUrl(endpoint, hostname, typeName) {
    const packet = encodeQuery(hostname, typeName);
    const sep = endpoint.includes('?') ? '&' : '?';
    return `${endpoint}${sep}dns=${base64UrlEncode(packet)}`;
  }

  /**
   * Resolve a hostname and return the raw decoded response.
   * Caching is applied by the typed helpers below, not here.
   */
  async query(hostname, typeName = 'A') {
    if (!hostname || typeof hostname !== 'string') {
      throw new TypeError('hostname must be a non-empty string');
    }
    const fetchFn = await this._fetch();
    if (typeof fetchFn !== 'function') {
      throw new Error('no fetch implementation available');
    }

    let cancelled = false;
    let lastError = null;

    for (const endpoint of shuffle(this.endpoints)) {
      const controller = new AbortController();
      this.controllers.add(controller);
      const timer = setTimeout(() => {
        try { controller.abort(); } catch (_) { /* no-op */ }
      }, this.timeoutMs);

      try {
        const url = this.buildUrl(endpoint, hostname, typeName);
        const res = await fetchFn(url, {
          headers: { accept: 'application/dns-message' },
          signal: controller.signal,
        });
        if (!res || typeof res.arrayBuffer !== 'function') {
          throw new Error('invalid dns response object');
        }
        if (typeof res.status === 'number' && res.status >= 400) {
          throw new Error(`dns endpoint http ${res.status}`);
        }
        const buf = Buffer.from(await res.arrayBuffer());
        return decodeResponse(buf);
      } catch (err) {
        lastError = err;
        if (controller.signal.aborted) cancelled = true;
        this._note(endpoint, err);
      } finally {
        clearTimeout(timer);
        this.controllers.delete(controller);
      }
    }

    if (cancelled && !lastError) {
      throw Object.assign(new Error('dns query cancelled'), { code: 'ECANCELLED' });
    }
    if (cancelled) {
      throw Object.assign(new Error('dns query cancelled'), { code: 'ECANCELLED', cause: lastError });
    }
    throw lastError || new Error(`could not resolve ${hostname} ${typeName}`);
  }

  async _resolveTyped(hostname, typeName, cache) {
    const key = `${typeName}_${hostname}`;
    const hit = cache.get(key);
    if (hit) return hit;

    const response = await this.query(hostname, typeName);
    if (response.rcode !== 0) {
      const err = new Error(`dns rcode ${response.rcode} for ${hostname}`);
      err.code = `DNS_RCODE_${response.rcode}`;
      throw err;
    }
    const answers = response.answers.filter((a) => a.type === typeName);
    if (!answers.length) {
      throw Object.assign(new Error(`no ${typeName} record for ${hostname}`), { code: 'ENODATA' });
    }
    const value = answers.map((a) => a.data);
    const minTtl = answers.reduce((acc, a) => {
      const ttl = Number(a.ttl);
      return Number.isFinite(ttl) && ttl > 0 ? Math.min(acc, ttl) : acc;
    }, Number.POSITIVE_INFINITY);
    cache.set(key, value, Number.isFinite(minTtl) ? minTtl : 60);
    return value;
  }

  resolve4(hostname) {
    return this._resolveTyped(hostname, 'A', this.cache);
  }

  resolve6(hostname) {
    return this._resolveTyped(hostname, 'AAAA', this.cache);
  }

  resolveTxt(hostname) {
    return this._resolveTyped(hostname, 'TXT', this.textCache).then((rows) => rows.map((v) => [v]));
  }

  resolveCname(hostname) {
    return this._resolveTyped(hostname, 'CNAME', this.cache);
  }

  async resolve(hostname, rrType = 'A') {
    const type = String(rrType).toUpperCase();
    switch (type) {
      case 'A': return this.resolve4(hostname);
      case 'AAAA': return this.resolve6(hostname);
      case 'TXT': return this.resolveTxt(hostname);
      case 'CNAME': return this.resolveCname(hostname);
      default:
        return this._resolveTyped(hostname, type, this.cache);
    }
  }
}

/** Patch global lookup order so `dns.lookup` prefers this resolver. */
/**
 * Build a `lookup` function scoped to one request.
 *
 * `http.request` and `https.request` accept a `lookup` option, and Node calls
 * it for that connection only. That is a better fit than replacing the
 * process-wide resolver, which silently changes every socket in the runtime —
 * including ones that must not be resolved this way, such as a proxy host, a
 * loopback service, or an address the caller deliberately pinned.
 *
 * The returned function follows the `dns.lookup` contract:
 *   - `callback(err, address, family)` by default
 *   - `callback(err, [{ address, family }])` when `options.all` is set
 *
 * Names the resolver cannot answer for fall back to the system resolver, so a
 * record the configured DoH endpoint does not carry never becomes a hard
 * failure. Pass `{ fallback: null }` to disable that.
 *
 * @param {object} resolver instance exposing `resolve4` and `resolve6`
 * @param {{fallback?:Function|null, systemLookup?:Function}} [options]
 * @returns {Function} a `lookup` implementation
 */
function createDohLookup(resolver, options = {}) {
  if (!resolver || typeof resolver.resolve4 !== 'function') {
    throw new TypeError('resolver required');
  }
  const systemLookup = options.systemLookup || dns.lookup;
  const fallback = options.fallback === undefined ? systemLookup : options.fallback;

  function useSystem(hostname, opts, callback) {
    if (typeof fallback !== 'function') {
      const error = new Error(`No record for ${hostname}`);
      error.code = 'ENOTFOUND';
      callback(error);
      return;
    }
    fallback(hostname, opts, callback);
  }

  return function dohLookup(hostname, opts, callback) {
    const settings = typeof opts === 'function' ? {} : (opts || {});
    const done = typeof opts === 'function' ? opts : callback;
    if (typeof done !== 'function') throw new TypeError('callback required');

    const wantsAll = settings.all === true;
    const family = settings.family;

    const lookupFamily = (target) => (family === 6 ? resolver.resolve6(target) : resolver.resolve4(target));

    Promise.resolve()
      .then(() => lookupFamily(hostname))
      .then((addresses) => {
        const list = (Array.isArray(addresses) ? addresses : [addresses]).filter(Boolean);
        if (list.length === 0) throw Object.assign(new Error(`No record for ${hostname}`), { code: 'ENODATA' });
        if (wantsAll) {
          done(null, list.map((address) => ({ address, family: family === 6 ? 6 : 4 })));
          return;
        }
        done(null, list[0], family === 6 ? 6 : 4);
      })
      .catch((error) => {
        // Only a missing record is worth retrying through the system
        // resolver; a transport failure is reported so the caller can decide.
        if (error && (error.code === 'ENODATA' || error.code === 'ENOTFOUND')) {
          useSystem(hostname, settings, done);
          return;
        }
        done(error);
      });

    return undefined;
  };
}

function installLookupPatch(resolver, originalLookup = dns.lookup) {
  if (!resolver || typeof resolver.resolve4 !== 'function') {
    throw new TypeError('resolver required');
  }
  dns.lookup = function patchedLookup(hostname, options, callback) {
    let opts = options;
    let cb = callback;
    if (typeof opts === 'function') {
      cb = opts;
      opts = {};
    }
    const family = opts && opts.family;
    if (family === 6) {
      resolver.resolve6(hostname).then(
        (addrs) => cb(null, addrs[0], 6),
        (err) => {
          if (err && (err.code === 'ENODATA' || err.code === 'ENOTFOUND')) {
            return originalLookup(hostname, opts, cb);
          }
          cb(err);
        }
      );
      return undefined;
    }
    resolver.resolve4(hostname).then(
      (addrs) => cb(null, addrs[0], 4),
      (err) => {
        if (err && (err.code === 'ENODATA' || err.code === 'ENOTFOUND')) {
          return originalLookup(hostname, opts, cb);
        }
        cb(err);
      }
    );
    return undefined;
  };
  return () => { dns.lookup = originalLookup; };
}

module.exports = {
  DohResolver,
  encodeQuery,
  decodeResponse,
  readName,
  TtlCache,
  base64UrlEncode,
  installLookupPatch,
  createDohLookup,
  getIpFromAnswer,
  buildFullPath,
  isAbsoluteUrl,
  combineUrls,
  DEFAULT_ENDPOINTS,
  TYPE_BY_NAME,
  NAME_BY_TYPE,
};
