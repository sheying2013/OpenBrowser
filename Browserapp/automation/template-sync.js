'use strict';

/**
 * RPA 模版商店 API 客户端（可选远程同步）。
 *
 * 仓库内不内置任何长期远程域名；调用方必须显式传入 base / origin。
 * 运行时默认走本地离线包 automation/data/catalog-templates.json。
 *
 * 鉴权要点：
 *   - Cookie: mix_auth_token / mix_sys_token / …
 *   - Header: Cpl = LOCAL_KEY_IN_WEBSITE（缺省会导致 4006/1500）
 *
 * 接口（相对 base）：
 *   GET rpav2/template/category-list?lang=
 *   GET rpav2/template/template-list?lang=&keyword=&sort=&category_id=&pay_type=&page=&page_size=
 *   GET rpav2/template/template-info?template_id=&lang=  → 含 uri（.json.gz 流程包）
 *   GET uri → gunzip → process graph（或字段 c 经 AES 解密）
 *
 * 解密：key = md5(template_id).hex[0:16]，AES-CBC，iv=key
 */

const https = require('https');
const http = require('http');
const crypto = require('crypto');
const zlib = require('zlib');
const { parseProcessContent } = require('./protocol/rpa-registry');

function requestRaw(url, { method = 'GET', headers = {}, body = null, timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method,
      headers: {
        Accept: '*/*',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36',
        ...headers,
      },
      timeout,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, buffer: Buffer.concat(chunks), headers: res.headers }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

async function requestJson(url, opts = {}) {
  const { status, buffer } = await requestRaw(url, {
    ...opts,
    headers: { Accept: 'application/json, text/plain, */*', ...(opts.headers || {}) },
  });
  let data;
  try { data = JSON.parse(buffer.toString('utf8')); }
  catch (_) { throw new Error(`非 JSON 响应 HTTP ${status}: ${buffer.toString('utf8').slice(0, 200)}`); }
  return { status, data };
}

function authHeaders(config = {}) {
  const headers = {};
  // Cpl is mandatory for marketplace APIs
  const cpl = config.cpl || config.Cpl || extractCookieValue(config.cookie, 'LOCAL_KEY_IN_WEBSITE');
  if (cpl) headers.Cpl = String(cpl);
  if (config.cookie) headers.Cookie = String(config.cookie);
  if (config.token && !config.cookie) {
    headers.Cookie = `mix_auth_token=${config.token}`;
  }
  if (config.apiKey) headers['Api-Key'] = String(config.apiKey);
  if (config.origin) {
    headers.Origin = String(config.origin);
    headers.Referer = String(config.origin).replace(/\/$/, '') + '/rpa/marketplace';
  }
  if (config.extraHeaders && typeof config.extraHeaders === 'object') {
    Object.assign(headers, config.extraHeaders);
  }
  return headers;
}

function extractCookieValue(cookieHeader, name) {
  if (!cookieHeader) return '';
  const m = String(cookieHeader).match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : '';
}

function unwrap(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('空响应');
  const code = payload.code;
  if (code !== undefined && code !== 0 && code !== '0' && code !== 200) {
    throw new Error(`远程模版 API code=${code}: ${payload.msg || payload.message || '失败'}`);
  }
  return payload.data !== undefined ? payload.data : payload;
}

/** AES decrypt marketplace encrypted pack field `c` */
function decryptProcessCipher(ciphertextB64, templateId) {
  const keySrc = crypto.createHash('md5').update(String(templateId)).digest('hex').slice(0, 16);
  const key = Buffer.from(keySrc, 'utf8');
  const ct = Buffer.from(String(ciphertextB64), 'base64');
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, key);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return JSON.parse(pt.toString('utf8'));
}

/** Download .json.gz process pack from signed OSS uri */
async function fetchProcessPack(uri, templateId) {
  const { buffer } = await requestRaw(uri, { timeout: 45000 });
  let text;
  try {
    text = zlib.gunzipSync(buffer).toString('utf8');
  } catch (_) {
    text = buffer.toString('utf8');
  }
  const pack = JSON.parse(text);
  if (pack && typeof pack === 'object' && pack.c) {
    return decryptProcessCipher(pack.c, templateId);
  }
  return pack;
}

/** Flatten RPA Plus graph (nodes[].data.type) to parseProcessContent shape */
function graphToProcessContent(pack) {
  if (!pack || typeof pack !== 'object') return pack;
  if (Array.isArray(pack.steps)) return pack;
  const nodes = (pack.nodes || []).map((n) => {
    const data = n.data && typeof n.data === 'object' ? n.data : {};
    const type = data.type || n.type;
    const flat = { ...data };
    delete flat.nodeInfo;
    delete flat.type;
    return { id: n.id, type, ...flat };
  });
  return { nodes, edges: pack.edges || [] };
}

class TemplateClient {
  constructor(config = {}) {
    const base = String(config.base || '').trim();
    if (!base) {
      throw new Error('未配置远程模版 API base：仓库不内置长期连接域名，请显式传入 config.base');
    }
    this.base = base.replace(/\/$/, '');
    this.lang = config.lang || 'zh-CN';
    this.config = config;
  }

  url(path, params = {}) {
    const u = new URL(this.base + (path.startsWith('/') ? path : `/${path}`));
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === '') continue;
      u.searchParams.set(k, String(v));
    }
    return u.toString();
  }

  async get(path, params = {}) {
    const { data } = await requestJson(this.url(path, params), {
      headers: authHeaders(this.config),
    });
    return unwrap(data);
  }

  async categoryList() {
    return this.get('rpav2/template/category-list', { lang: this.lang });
  }

  async templateList(query = {}) {
    return this.get('rpav2/template/template-list', {
      lang: this.lang,
      page: query.page || 1,
      page_size: query.page_size || query.pageSize || 50,
      keyword: query.keyword || query.q || '',
      sort: query.sort || 'use_num',
      category_id: query.category_id || query.categoryId || '',
      pay_type: query.pay_type || query.payType || '',
    });
  }

  async templateInfo(templateId) {
    return this.get('rpav2/template/template-info', {
      template_id: templateId,
      lang: this.lang,
    });
  }

  async useNum(templateId) {
    return this.get('rpav2/template/use-num', { template_id: templateId });
  }
}

function normalizeRemoteTemplate(item = {}, detail = null, processContent = null) {
  const src = { ...item, ...(detail || {}) };
  const id = String(src.id || src.template_id || '');
  if (!id) throw new Error('模版缺少 id');

  let pc = processContent || src.process_content || src.processContent || null;
  if (typeof pc === 'string') {
    try { pc = JSON.parse(pc); } catch (_) { /* keep */ }
  }
  if (pc && pc.nodes && pc.nodes[0] && pc.nodes[0].data) {
    pc = graphToProcessContent(pc);
  }

  let steps = [];
  if (Array.isArray(src.steps) && src.steps.length) steps = src.steps;
  else if (pc) steps = parseProcessContent(pc);

  return {
    id: `remote-${id}`,
    external_id: id,
    name: String(src.name || src.template_name || `远程模版 ${id}`).slice(0, 120),
    cat: String(src.category_name || src.category || src.cat || 'Other').slice(0, 40),
    category_id: src.category_id != null ? String(src.category_id) : '',
    desc: String(src.description || src.abstract || src.desc || '').replace(/<[^>]+>/g, ' ').slice(0, 800),
    tags: Array.isArray(src.tags) ? src.tags.map(String) : ['远程', '免费'],
    steps,
    process_content: pc,
    uses: Number(src.use_num || src.uses || 0) || 0,
    pay_type: 1,
    price: src.price != null ? Number(src.price) : 0,
    developer: typeof src.developer === 'object' && src.developer
      ? String(src.developer.name || 'Remote')
      : String(src.developer || src.author || 'Remote').slice(0, 80),
    img_url: src.img_url || src.cover || src.uri || '',
    builtin: false,
    source: 'remote',
    create_time: src.create_time || new Date().toISOString(),
    update_time: src.updated_time || src.update_time || new Date().toISOString(),
  };
}

/**
 * Sync free (or filtered) templates. withDetail downloads uri process packs.
 * Requires explicit config.base (no hard-coded host in repository).
 */
async function syncRemoteTemplateStore(config = {}, options = {}) {
  if (!String(config.base || '').trim()) {
    throw new Error('未配置远程模版 API base：请显式传入 base，或使用本地离线包 loadBundledCatalogDump()');
  }
  const client = new TemplateClient(config);
  const pageSize = options.pageSize || 50;
  const maxPages = options.maxPages || 20;
  const withDetail = options.withDetail !== false;
  const payType = options.pay_type != null ? options.pay_type : (options.freeOnly === false ? '' : '1');

  let categories = [];
  try {
    const catRaw = await client.categoryList();
    if (Array.isArray(catRaw)) categories = catRaw;
    else if (Array.isArray(catRaw?.list)) categories = catRaw.list;
  } catch (err) {
    if (options.strict) throw err;
  }

  const list = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const raw = await client.templateList({
      page,
      page_size: pageSize,
      sort: options.sort || 'use_num',
      pay_type: payType,
    });
    let batch = [];
    if (Array.isArray(raw)) batch = raw;
    else if (Array.isArray(raw?.list)) batch = raw.list;
    if (!batch.length) break;

    for (const item of batch) {
      // free only safety
      if (payType === '1' || payType === 1) {
        if (String(item.pay_type) !== '1' && Number(item.price) > 0) continue;
      }
      let detail = null;
      let processContent = null;
      if (withDetail && (item.id || item.template_id)) {
        const tid = item.id || item.template_id;
        try {
          detail = await client.templateInfo(tid);
          if (detail?.data && !detail.id) detail = detail.data;
          const uri = detail?.uri || item.uri;
          if (uri) {
            const pack = await fetchProcessPack(uri, tid);
            processContent = graphToProcessContent(pack);
          }
        } catch (_) { /* keep list meta */ }
      }
      try {
        list.push(normalizeRemoteTemplate(item, detail, processContent));
      } catch (_) { /* skip */ }
    }
    if (batch.length < pageSize) break;
  }

  return {
    categories: categories.map((c) => ({
      id: String(c.id ?? c.category_id ?? ''),
      name: String(c.name || c.category_name || c.title || ''),
    })).filter((c) => c.name),
    templates: list,
    synced_at: new Date().toISOString(),
  };
}

/** Load bundled offline dump written by scrape script */
function loadBundledCatalogDump() {
  const fs = require('fs');
  const path = require('path');
  const p = path.join(__dirname, 'data', 'catalog-templates.json');
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    return null;
  }
}

module.exports = {
  TemplateClient,
  normalizeRemoteTemplate,
  syncRemoteTemplateStore,
  parseProcessContent,
  fetchProcessPack,
  graphToProcessContent,
  decryptProcessCipher,
  loadBundledCatalogDump,
};
