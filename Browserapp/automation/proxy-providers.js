'use strict';

const {
  parseProxy,
  fetchUrlText,
  lookupProxyCountry,
  isProxyLinkError,
  classifyProxyError,
} = require('../proxy-forwarder');

const MAX_PROVIDER_BATCH_SIZE = 500;
const PROVIDER_COOLDOWN_MS = 60 * 1000;
const MAX_PROBE_CONCURRENCY = 16;
const DEFAULT_PROBE_CONCURRENCY = 8;

const providerCooldowns = new Map();

function normalizeProviderUrl(url) {
  const trimmed = String(url || '').trim();
  if (!trimmed) throw new Error('提取 URL 不能为空');
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch (_) {
    throw new Error('提取 URL 格式无效');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('提取 URL 必须以 http:// 或 https:// 开头');
  }
  return parsed.toString();
}

function clearProviderCooldowns() {
  providerCooldowns.clear();
}

function getProviderCooldownRemaining(url) {
  try {
    const key = normalizeProviderUrl(url);
    const last = providerCooldowns.get(key);
    if (!last) return 0;
    const elapsed = Date.now() - last;
    return Math.max(0, PROVIDER_COOLDOWN_MS - elapsed);
  } catch (_) {
    return 0;
  }
}

function recordProviderFetch(url) {
  const key = normalizeProviderUrl(url);
  providerCooldowns.set(key, Date.now());
}

/**
 * Normalizes an extracted proxy endpoint into a canonical proxy descriptor object.
 */
function buildCanonicalProxyItem(parsed, defaultProtocol = 'socks5', remark = '') {
  const protocol = String(parsed.protocol || defaultProtocol || 'socks5').toLowerCase().replace('://', '');
  const host = String(parsed.host || parsed.ip || '').trim();
  const port = Number(parsed.port);
  const username = String(parsed.username || parsed.user || '');
  const password = String(parsed.password || parsed.pass || '');

  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    return null;
  }

  const authPart = username || password
    ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@`
    : '';
  const raw = `${protocol}://${authPart}${host}:${port}`;
  const itemRemark = String(parsed.remark || remark || '供应商 API 导入').trim().slice(0, 500);

  return {
    name: parsed.name ? String(parsed.name).trim().slice(0, 120) : `${host}:${port}`,
    protocol,
    host,
    port,
    username,
    password,
    raw,
    remark: itemRemark,
  };
}

function proxyIdentityKey(item) {
  if (!item) return '';
  const auth = item.username || item.password ? `${item.username}:${item.password}@` : '';
  return `${item.protocol}://${auth}${item.host}:${item.port}`.toLowerCase();
}

/**
 * Parses raw provider response according to specified template or auto-detection.
 * Supports:
 * 1. Text line-by-line: ip:port
 * 2. Text line-by-line: ip:port:user:pass (and protocol://user:pass@host:port)
 * 3. JSON array with field mapping (root array or nested under data/proxies/list/items)
 */
function parseProviderResponse(rawBody, options = {}) {
  const text = typeof rawBody === 'string' ? rawBody.trim() : JSON.stringify(rawBody);
  if (!text) return [];

  const template = String(options.template || options.format || 'auto').toLowerCase();
  const defaultProtocol = String(options.protocol || 'socks5').toLowerCase();
  const limit = Math.min(MAX_PROVIDER_BATCH_SIZE, Math.max(1, Number(options.limit) || MAX_PROVIDER_BATCH_SIZE));
  const fieldMapping = options.fieldMapping && typeof options.fieldMapping === 'object' ? options.fieldMapping : {};
  const customRemark = String(options.remark || '').trim();

  let candidateItems = [];

  const tryJson = template === 'json' || template === 'auto';
  let jsonParsed = null;
  if (tryJson) {
    try {
      jsonParsed = JSON.parse(text);
    } catch (_) {
      jsonParsed = null;
    }
  }

  if (jsonParsed != null) {
    candidateItems = parseJsonProviderItems(jsonParsed, fieldMapping, defaultProtocol);
  } else {
    candidateItems = parseTextProviderLines(text, template, defaultProtocol);
  }

  const unique = [];
  const seenKeys = new Set();
  for (const candidate of candidateItems) {
    const item = buildCanonicalProxyItem(candidate, defaultProtocol, customRemark);
    if (!item) continue;
    const key = proxyIdentityKey(item);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    unique.push(item);
    if (unique.length >= limit) break;
  }

  return unique;
}

function parseTextProviderLines(text, template, defaultProtocol) {
  const lines = text.split(/[\r\n,;]+/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#') && !line.startsWith('//'));
  const results = [];

  for (const line of lines) {
    if (line.length > 500) continue;
    const parsed = parseSingleLineProxy(line, template, defaultProtocol);
    if (parsed) results.push(parsed);
  }
  return results;
}

function parseSingleLineProxy(line, template, defaultProtocol) {
  const clean = line.replace(/^[a-z]+:\/\//i, (match) => {
    return match.toLowerCase();
  });

  // Check if standard URL parse works (protocol://user:pass@host:port#remark)
  if (/^[a-z0-9]+:\/\//i.test(clean)) {
    try {
      const config = parseProxy(clean);
      if (config) {
        return {
          protocol: config.protocol,
          host: config.host,
          port: config.port,
          username: config.username || '',
          password: config.password || '',
          name: config.name || `${config.host}:${config.port}`,
          remark: config.remark || '',
        };
      }
    } catch (_) {}
  }

  // Handle user:pass@host:port
  const atMatch = clean.match(/^(?:(?<user>[^:@]+):(?<pass>[^@]+)@)?(?<host>[a-zA-Z0-9.-]+):(?<port>\d{1,5})(?:#(?<remark>.*))?$/);
  if (atMatch && atMatch.groups.user && atMatch.groups.pass) {
    return {
      protocol: defaultProtocol,
      host: atMatch.groups.host,
      port: Number(atMatch.groups.port),
      username: atMatch.groups.user,
      password: atMatch.groups.pass,
      remark: atMatch.groups.remark || '',
    };
  }

  // Split by colon
  const colonParts = clean.split('#')[0].split(':').map((p) => p.trim());
  const hashRemark = clean.includes('#') ? clean.slice(clean.indexOf('#') + 1).trim() : '';

  // Format 2: ip:port:user:pass (4 colon parts)
  if (colonParts.length === 4) {
    const [host, portStr, username, password] = colonParts;
    const port = Number(portStr);
    if (host && Number.isInteger(port) && port >= 1 && port <= 65535) {
      return {
        protocol: defaultProtocol,
        host,
        port,
        username,
        password,
        remark: hashRemark,
      };
    }
  }

  // Format 1: ip:port (2 colon parts)
  if (colonParts.length === 2) {
    const [host, portStr] = colonParts;
    const port = Number(portStr);
    if (host && Number.isInteger(port) && port >= 1 && port <= 65535) {
      return {
        protocol: defaultProtocol,
        host,
        port,
        username: '',
        password: '',
        remark: hashRemark,
      };
    }
  }

  return null;
}

function parseJsonProviderItems(json, fieldMapping, defaultProtocol) {
  let list = [];
  if (Array.isArray(json)) {
    list = json;
  } else if (json && typeof json === 'object') {
    if (Array.isArray(json.data)) list = json.data;
    else if (Array.isArray(json.proxies)) list = json.proxies;
    else if (Array.isArray(json.list)) list = json.list;
    else if (Array.isArray(json.items)) list = json.items;
    else if (Array.isArray(json.rows)) list = json.rows;
    else if (Array.isArray(json.result)) list = json.result;
    else if (json.data && typeof json.data === 'object' && Array.isArray(json.data.list)) list = json.data.list;
    else if (json.data && typeof json.data === 'object' && Array.isArray(json.data.proxies)) list = json.data.proxies;
  }

  const results = [];
  for (const item of list) {
    if (!item) continue;
    if (typeof item === 'string') {
      const parsed = parseSingleLineProxy(item, 'auto', defaultProtocol);
      if (parsed) results.push(parsed);
      continue;
    }
    if (typeof item === 'object') {
      const host = item[fieldMapping.ip] ?? item[fieldMapping.host]
        ?? item.ip ?? item.host ?? item.server ?? item.proxy_ip ?? item.proxyIp ?? item.addr ?? item.address;
      const port = item[fieldMapping.port]
        ?? item.port ?? item.proxy_port ?? item.proxyPort;
      const username = item[fieldMapping.user] ?? item[fieldMapping.username]
        ?? item.user ?? item.username ?? item.user_name ?? item.account ?? item.auth_user ?? item.login ?? '';
      const password = item[fieldMapping.pass] ?? item[fieldMapping.password]
        ?? item.pass ?? item.password ?? item.pwd ?? item.auth_pass ?? '';
      const protocol = item[fieldMapping.protocol]
        ?? item.protocol ?? item.proto ?? item.type ?? item.proxy_type ?? defaultProtocol;
      const remark = item[fieldMapping.remark] ?? item.remark ?? item.note ?? item.country ?? '';

      if (host && port) {
        results.push({
          protocol: String(protocol || defaultProtocol).toLowerCase(),
          host: String(host).trim(),
          port: Number(port),
          username: String(username || ''),
          password: String(password || ''),
          remark: String(remark || ''),
        });
      }
    }
  }
  return results;
}

/**
 * Fetch and parse proxies from a provider extraction URL.
 * Enforces:
 * - URL validation
 * - 60s cooldown per unique URL (ERR_COOLDOWN)
 * - Upper ceiling <= 500
 * - Deduplication
 */
async function fetchProviderProxies(url, options = {}) {
  const normalizedUrl = normalizeProviderUrl(url);

  if (!options.bypassCooldown) {
    const remainingMs = getProviderCooldownRemaining(normalizedUrl);
    if (remainingMs > 0) {
      const seconds = Math.ceil(remainingMs / 1000);
      const error = new Error(`请求过于频繁，同一提取 URL 冷却时间为 60 秒（剩余 ${seconds} 秒）`);
      error.code = 'ERR_COOLDOWN';
      error.remainingMs = remainingMs;
      throw error;
    }
  }

  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 15000;
  const { body } = await fetchUrlText(normalizedUrl, {
    timeout: timeoutMs,
    allowPrivate: options.allowPrivate !== false,
  });

  recordProviderFetch(normalizedUrl);

  const proxies = parseProviderResponse(body, options);
  return {
    ok: true,
    total: proxies.length,
    proxies,
    url: normalizedUrl,
  };
}

/**
 * Batch speed test runner with controlled concurrency (<= 16).
 * Measures RTT (latencyMs) and exit country.
 * Updates proxy store entries if store is supplied.
 */
async function batchSpeedTest(proxies, options = {}) {
  const list = Array.isArray(proxies) ? proxies : [];
  if (!list.length) {
    return { total: 0, completed: 0, okCount: 0, failCount: 0, results: [], sorted: [] };
  }

  const maxConcurrency = Math.min(MAX_PROBE_CONCURRENCY, Math.max(1, Number(options.concurrency) || DEFAULT_PROBE_CONCURRENCY));
  const store = options.store || null;
  const probeFn = typeof options.probeFn === 'function' ? options.probeFn : async (proxy) => {
    const config = parseProxy(proxy.raw || proxy);
    return await lookupProxyCountry(config, {
      force: true,
      totalTimeoutMs: options.timeoutMs || 6000,
      attemptTimeoutMs: options.attemptTimeoutMs || 2500,
    });
  };

  const results = new Array(list.length);
  let currentIndex = 0;
  let okCount = 0;
  let failCount = 0;

  async function worker() {
    while (currentIndex < list.length) {
      const index = currentIndex++;
      const proxy = list[index];
      const proxyId = proxy.id || null;
      const started = Date.now();
      try {
        const lookup = await probeFn(proxy);
        const latencyMs = Number.isFinite(lookup.latencyMs) ? Number(lookup.latencyMs) : (Date.now() - started);
        const resultItem = {
          id: proxyId,
          proxy,
          ok: true,
          latencyMs,
          ip: lookup.ip || '',
          countryCode: lookup.countryCode || lookup.country_code || '',
          country: lookup.country || '',
          networkType: lookup.networkType || '',
          errorClass: '',
          error: null,
        };
        if (store && proxyId && typeof store.markCheck === 'function') {
          await store.markCheck(proxyId, resultItem).catch(() => {});
        }
        results[index] = resultItem;
        okCount++;
        options.onProgress?.({ index, total: list.length, result: resultItem });
      } catch (error) {
        const latencyMs = Number.isFinite(error.latencyMs) ? Number(error.latencyMs) : (Date.now() - started);
        const errorClass = error.errorClass || classifyProxyError(error) || error.code || 'unknown';
        const resultItem = {
          id: proxyId,
          proxy,
          ok: false,
          latencyMs,
          ip: '',
          countryCode: '',
          country: '',
          networkType: '',
          errorClass,
          error: error.message || String(error),
        };
        if (store && proxyId && typeof store.markCheckError === 'function') {
          await store.markCheckError(proxyId, { errorClass, latencyMs }).catch(() => {});
        }
        results[index] = resultItem;
        failCount++;
        options.onProgress?.({ index, total: list.length, result: resultItem });
      }
    }
  }

  const workerCount = Math.min(maxConcurrency, list.length);
  const workers = Array.from({ length: workerCount }, () => worker());
  await Promise.all(workers);

  const sorted = [...results].sort((a, b) => {
    const latA = a.ok && Number.isFinite(a.latencyMs) ? a.latencyMs : Infinity;
    const latB = b.ok && Number.isFinite(b.latencyMs) ? b.latencyMs : Infinity;
    return latA - latB;
  });

  return {
    total: list.length,
    completed: results.length,
    okCount,
    failCount,
    results,
    sorted,
  };
}

module.exports = {
  fetchProviderProxies,
  parseProviderResponse,
  batchSpeedTest,
  clearProviderCooldowns,
  getProviderCooldownRemaining,
  recordProviderFetch,
  normalizeProviderUrl,
  MAX_PROVIDER_BATCH_SIZE,
  PROVIDER_COOLDOWN_MS,
  MAX_PROBE_CONCURRENCY,
};
