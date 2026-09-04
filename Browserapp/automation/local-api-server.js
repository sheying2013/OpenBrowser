'use strict';

const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');

const MAX_BODY_BYTES = 1024 * 1024;

function responseHeaders(origin = '') {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };
  if (origin) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers.Vary = 'Origin';
    headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization, api-key, x-api-key';
    headers['Access-Control-Allow-Methods'] = 'GET,POST,PUT,DELETE,OPTIONS';
  }
  return headers;
}

function sendJson(res, status, body, origin = '') {
  const payload = JSON.stringify(body);
  res.writeHead(status, responseHeaders(origin));
  res.end(payload);
}

function ok(data = {}, msg = 'success') {
  return { code: 0, msg, data };
}

function fail(msg, code = -1, data = null) {
  return { code, msg: String(msg || 'error'), data };
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error('request body too large');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (_) {
    const params = new URLSearchParams(raw);
    return Object.fromEntries(params.entries());
  }
}

function parseResolution(value) {
  if (value && typeof value === 'object') {
    return [Number(value.width), Number(value.height)];
  }
  const text = String(value || '').trim();
  const match = text.match(/(\d+)\s*[x×*]\s*(\d+)/i) || text.match(/^(\d+)[,\s]+(\d+)$/);
  if (!match) return [NaN, NaN];
  return [Number(match[1]), Number(match[2])];
}

function parseGeolocation(value) {
  if (value && typeof value === 'object') {
    return [Number(value.latitude ?? value.lat), Number(value.longitude ?? value.lon ?? value.lng)];
  }
  const parts = String(value || '').split(/[,;:\s]+/).map(Number);
  if (parts.length >= 2 && parts.every(Number.isFinite)) return [parts[0], parts[1]];
  return [NaN, NaN];
}

/**
 * Accept both the UI's camelCase profile shape and the MCP/API snake_case
 * shape. The profile engine only understands a few top-level fields
 * (width/height/userAgent/startUrl/note), while the rest live under
 * privacy/privacy.fingerprint. Without this bridge, MCP fields such as
 * start_url, user_agent, resolution or fingerprint were silently dropped.
 */
function normalizeProfileInput(input = {}) {
  const out = { ...input };
  const privacy = { ...(out.privacy && typeof out.privacy === 'object' ? out.privacy : {}) };
  let fingerprint = out.fingerprint && typeof out.fingerprint === 'object' ? { ...out.fingerprint } : {};
  const clearFingerprint = out.fingerprint === null || out.privacy?.fingerprint === null;

  if (out.start_url !== undefined) out.startUrl = out.start_url;
  if (out.user_agent !== undefined) out.userAgent = out.user_agent;
  if (out.network_mode !== undefined) out.networkMode = out.network_mode;
  if (out.language_code !== undefined) out.languageCode = out.language_code;
  if (typeof out.platform === 'string') out.platform = { type: out.platform };

  const sizeValue = out.resolution ?? out.window_size ?? out.windowSize;
  if (sizeValue !== undefined) {
    const [width, height] = parseResolution(sizeValue);
    if (Number.isFinite(width)) out.width = width;
    if (Number.isFinite(height)) out.height = height;
  }
  if (out.notes !== undefined) out.note = out.notes;
  if (out.privacy_extra && typeof out.privacy_extra === 'object') Object.assign(privacy, out.privacy_extra);

  if (out.timezone !== undefined && String(out.timezone).trim()) {
    privacy.timezone = String(out.timezone).trim();
    privacy.timezoneMode = 'custom';
  }
  if (out.locale !== undefined && String(out.locale).trim()) {
    privacy.uiLanguage = String(out.locale).trim();
    privacy.languageMode = String(out.locale).trim();
  }
  if (out.geolocation !== undefined) {
    const [lat, lon] = parseGeolocation(out.geolocation);
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      privacy.latitude = lat;
      privacy.longitude = lon;
      privacy.geoMode = 'custom';
    }
  }
  if (out.webgl_vendor !== undefined && String(out.webgl_vendor).trim()) {
    fingerprint.webglVendor = String(out.webgl_vendor).trim();
    privacy.webglMeta = 'custom';
  }
  if (out.webgl_renderer !== undefined && String(out.webgl_renderer).trim()) {
    fingerprint.webglRenderer = String(out.webgl_renderer).trim();
    privacy.webglMeta = 'custom';
  }
  if (out.hardware_concurrency !== undefined) {
    const n = Number(out.hardware_concurrency);
    if (Number.isFinite(n)) {
      privacy.cores = n;
      fingerprint.hardwareConcurrency = n;
    }
  }
  if (out.device_memory !== undefined) {
    const n = Number(out.device_memory);
    if (Number.isFinite(n)) {
      privacy.memory = n;
      fingerprint.deviceMemory = n;
    }
  }
  if (out.do_not_track !== undefined) {
    const enabled = out.do_not_track === true || out.do_not_track === 'on' || out.do_not_track === '1';
    privacy.dnt = enabled;
    privacy.dntMode = enabled ? 'on' : 'off';
  }

  if (clearFingerprint) {
    fingerprint = null;
    delete privacy.fingerprint;
  }
  if (fingerprint) {
    out.fingerprint = fingerprint;
    privacy.fingerprint = fingerprint;
  } else {
    delete out.fingerprint;
    delete privacy.fingerprint;
  }
  out.privacy = privacy;
  out.__clearFingerprint = clearFingerprint;
  return out;
}

function readProxyAssociation(input = {}) {
  const source = input && typeof input.profile === 'object' ? { ...input, ...input.profile } : input;
  for (const key of ['proxy_id', 'proxy_library_id', 'proxyId', 'proxyLibraryId']) {
    if (Object.prototype.hasOwnProperty.call(source || {}, key)) {
      return { present: true, value: source[key] == null ? '' : String(source[key]).trim() };
    }
  }
  return { present: false, value: '' };
}

function proxySummary(profile, proxyStore, explicitProxyId = undefined) {
  const proxyMeta = profile?.proxyMeta && typeof profile.proxyMeta === 'object' ? profile.proxyMeta : {};
  const profileProxyId = Object.prototype.hasOwnProperty.call(profile || {}, 'proxyId')
    ? profile.proxyId
    : (Object.prototype.hasOwnProperty.call(profile || {}, 'proxy_id') ? profile.proxy_id : undefined);
  const metaProxyId = Object.prototype.hasOwnProperty.call(proxyMeta, 'proxyId')
    ? proxyMeta.proxyId
    : proxyMeta.proxy_id;
  const proxyId = explicitProxyId === undefined
    ? String((profileProxyId !== undefined ? profileProxyId : metaProxyId) || '').trim()
    : String(explicitProxyId || '').trim();
  if (proxyId) {
    const summary = {
      proxy_id: proxyId,
      proxy_library_id: proxyId,
      proxy_status: proxyStore?.get(proxyId) ? 'linked' : 'missing',
    };
    return {
      ...summary,
      proxy: {
        id: proxyId,
        proxyId,
        proxy_id: proxyId,
        proxy_library_id: proxyId,
        status: summary.proxy_status,
      },
    };
  }
  const summary = {
    proxy_id: null,
    proxy_library_id: null,
    proxy_status: profile?.networkMode === 'proxy' ? 'manual' : 'direct',
  };
  return {
    ...summary,
    proxy: {
      id: null,
      proxyId: null,
      proxy_id: null,
      proxy_library_id: null,
      status: summary.proxy_status,
    },
  };
}

/**
 * Local HTTP API for OpenBrowser control plane.
 * Response envelope uses {code,msg,data}.
 */
class LocalApiServer {
  constructor(options = {}) {
    this.host = options.host || '127.0.0.1';
    const configuredPort = options.port === undefined ? 50325 : Number(options.port);
    this.requestedPort = Number.isFinite(configuredPort) && configuredPort >= 0 ? configuredPort : 50325;
    this.port = this.requestedPort;
    this.apiKey = options.apiKey ? String(options.apiKey) : crypto.randomBytes(32).toString('base64url');
    this.allowedOrigins = new Set(options.allowedOrigins || []);
    this.engine = options.engine;
    this.rpaEngine = options.rpaEngine;
    this.rpaStore = options.rpaStore;
    this.syncBridge = options.syncBridge;
    this.appCenter = options.appCenter;
    this.proxyStore = options.proxyStore;
    this.getVersion = options.getVersion || (() => '1.0.0');
    this.server = null;
    this.startedAt = null;
  }

  authOk(req, url = null) {
    if (!this.apiKey) return true;
    const headerKey = req.headers['api-key'] || req.headers['x-api-key'] || '';
    const auth = String(req.headers.authorization || '');
    const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
    const queryKey = url?.searchParams ? (url.searchParams.get('api_key') || url.searchParams.get('api_token') || url.searchParams.get('key') || '') : '';
    let supplied = String(headerKey || bearer || queryKey || '').trim();
    if (supplied.startsWith('"') && supplied.endsWith('"')) supplied = supplied.slice(1, -1);
    if (supplied.startsWith("'") && supplied.endsWith("'")) supplied = supplied.slice(1, -1);
    if (!supplied) return false;
    const suppliedBuf = Buffer.from(supplied);
    const keyBuf = Buffer.from(this.apiKey);
    if (suppliedBuf.length !== keyBuf.length) return false;
    return crypto.timingSafeEqual(suppliedBuf, keyBuf);
  }

  allowedOrigin(req) {
    const origin = String(req.headers.origin || '');
    if (!origin) return '';
    return this.allowedOrigins.has(origin) ? origin : null;
  }

  async start() {
    if (this.server) return this.info();
    this.server = http.createServer((req, res) => this.handle(req, res));
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.requestedPort, this.host, () => {
        const address = this.server.address();
        if (address && typeof address === 'object' && Number.isFinite(address.port)) this.port = address.port;
        this.startedAt = Date.now();
        resolve();
      });
    });
    return this.info();
  }

  async stop() {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    await new Promise((resolve) => server.close(() => resolve()));
  }

  info() {
    return {
      host: this.host,
      port: this.port,
      url: `http://${this.host}:${this.port}/`,
      startedAt: this.startedAt,
      apiKeyRequired: Boolean(this.apiKey),
    };
  }

  async handle(req, res) {
    try {
      const origin = this.allowedOrigin(req);
      if (origin === null) return sendJson(res, 403, fail('origin not allowed', 403));
      if (req.method === 'OPTIONS') return sendJson(res, 204, ok(), origin);
      const url = new URL(req.url || '/', `http://${this.host}:${this.port}`);
      const pathname = url.pathname.replace(/\/+$/, '') || '/';

      if (!this.authOk(req, url)) {
        return sendJson(res, 401, fail('unauthorized', 401), origin);
      }

      const body = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method || '') ? await readBody(req) : {};
      const query = Object.fromEntries(url.searchParams.entries());
      const input = { ...query, ...body };

      const result = await this.route(req.method || 'GET', pathname, input, req);
      if (result === undefined) return sendJson(res, 404, fail('not found', 404), origin);
      return sendJson(res, 200, result, origin);
    } catch (error) {
      const status = Number(error.statusCode) || 500;
      return sendJson(res, status, fail(status === 500 ? 'internal error' : error.message, status));
    }
  }

  async route(method, pathname, input) {
    // health / version
    if (pathname === '/' || pathname === '/status') {
      return ok({
        name: 'openbrowser-local-api',
        version: this.getVersion(),
        ...this.info(),
        runningProfiles: this.engine?.running?.size || 0,
        sync: this.syncBridge?.status?.() || null,
        rpa: this.rpaEngine?.getStatus?.() || null,
        platform: this.engine?.platformPreflightReport?.() || null,
      });
    }
    if (pathname === '/api/getVersion' || pathname === '/api/v1/version') {
      return ok({ version: this.getVersion(), soft: 'OpenBrowser' });
    }

    // ---- profiles (v1-style) ----
    if (pathname === '/api/v1/user/list' || pathname === '/api/v2/browser-profile/list' || pathname === '/api/profiles') {
      const list = this.engine.status().map((item) => ({
        user_id: item.id,
        profile_id: item.id,
        name: item.name,
        number: item.number,
        status: item.running ? 'Active' : 'Inactive',
        ws: item.port ? { puppeteer: `http://127.0.0.1:${item.port}`, selenium: `127.0.0.1:${item.port}` } : null,
        debug_port: item.port || null,
        ...proxySummary(item, this.proxyStore),
      }));
      return ok({ list, page: 1, page_size: list.length });
    }

    if (pathname === '/api/v1/user/create' || pathname === '/api/v2/browser-profile/create' || pathname === '/api/profiles/create') {
      if (!this.engine) return fail('profile engine unavailable');
      let body = normalizeProfileInput(input && typeof input.profile === 'object' ? { ...input, ...input.profile } : input);
      const association = this.resolveProxyAssociation(input, body);
      if (association.present) body = { ...body, ...association.patch };
      const existingIds = new Set(this.engine.profiles ? [...this.engine.profiles.keys()] : []);
      let id = String(body.user_id || body.profile_id || body.id || '').trim();
      if (!id) {
        do { id = 'ob-' + Date.now().toString(36) + '-' + crypto.randomBytes(5).toString('hex'); } while (existingIds.has(id));
      }
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return fail('invalid profile id');
      if (existingIds.has(id)) return fail('profile already exists');
      const numbers = this.engine.profiles ? [...this.engine.profiles.values()].map((item) => Number(item.number)).filter((n) => Number.isInteger(n) && n > 0) : [];
      const number = Number.isInteger(Number(body.number)) && Number(body.number) > 0 ? Number(body.number) : ((Math.max(0, ...numbers) || 0) + 1);
      const rawProxy = String(body.proxy || '').trim();
      const userProxy = body.user_proxy_config && typeof body.user_proxy_config === 'object' ? body.user_proxy_config : {};
      const proxyType = String(userProxy.proxy_type || 'http').toLowerCase();
      const proxyHost = String(userProxy.proxy_host || '').trim();
      const proxyPort = String(userProxy.proxy_port || '').trim();
      const proxyUser = String(userProxy.proxy_user || '');
      const proxyPassword = String(userProxy.proxy_password || '');
      const proxy = rawProxy || (proxyHost && proxyPort ? (proxyType === 'socks' ? 'socks5' : proxyType) + '://' + (proxyUser ? encodeURIComponent(proxyUser) + ':' + encodeURIComponent(proxyPassword) + '@' : '') + proxyHost + ':' + proxyPort : 'Direct');
      const profile = {
        ...body,
        id, number,
        name: String(body.name || body.title || ('Environment ' + number)),
        title: String(body.title || body.name || ('Environment ' + number)),
        language: String(body.language || 'en-US'),
        networkMode: body.networkMode || (/^(direct|offline|none)$/i.test(proxy) ? 'direct' : 'proxy'),
        proxy,
        privacy: {
          ...(body.privacy && typeof body.privacy === 'object' ? body.privacy : {}),
        },
      };
      // The engine's sanitizer may still reject structurally odd profiles (e.g. a
      // non-string name slipped past String() coercion). Surface that as a 400
      // request error rather than an internal 500 from syncProfiles' throw.
      let created;
      try {
        created = this.engine.sanitizeProfile(profile);
        created = this.normalizeProxyAssociationState(created, association);
        await this.engine.syncProfiles([created]);
      } catch (error) {
        return fail(`invalid profile: ${error.message}`, 400);
      }
      if (typeof this.engine.persist === 'function') await this.engine.persist();
      created = this.engine.profiles.get(id) || created;
      return ok({ user_id: id, profile_id: id, id, ...proxySummary(created, this.proxyStore), profile: created });
    }

    if (pathname === '/api/v2/browser-profile/update' || pathname === '/api/profiles/update') {
      if (!this.engine) return fail('profile engine unavailable');
      const id = String(input.profile_id || input.user_id || input.id || '');
      if (!id) return fail('profile id required');
      const current = this.engine.profiles.get(id);
      if (!current) return fail('profile not found');
      const clearFingerprint = Boolean(input.__clearFingerprint) || input.fingerprint === null || input.privacy?.fingerprint === null;
      let body = normalizeProfileInput(input);
      const association = this.resolveProxyAssociation(input, current);
      if (association.present) body = { ...body, ...association.patch };
      else if (Object.prototype.hasOwnProperty.call(input || {}, 'proxy')
        || Object.prototype.hasOwnProperty.call(input || {}, 'user_proxy_config')
        || String(input?.network_mode || '').toLowerCase() === 'direct') {
        body = { ...body, proxyId: null };
      }
      const allowed = new Set([
        'name', 'title', 'number', 'language', 'proxy', 'networkMode', 'startUrl', 'os', 'platform',
        'browser', 'userAgent', 'resolution', 'windowSize', 'timezone', 'locale', 'languageCode',
        'geolocation', 'webglVendor', 'webglRenderer', 'hardwareConcurrency', 'deviceMemory', 'doNotTrack',
        'privacy', 'fingerprint', 'user_proxy_config', 'note', 'width', 'height', 'advanced',
        'proxyMeta', 'tag', 'groupId', 'group_name',
        'proxyId',
      ]);
      const patch = {};
      for (const [key, value] of Object.entries(body)) {
        if (!allowed.has(key)) continue;
        if (key === 'startUrl' && value !== undefined) patch.startUrl = value;
        else if (key === 'userAgent' && value !== undefined) patch.userAgent = value;
        else if (key === 'windowSize' && value !== undefined) patch.windowSize = value;
        else if (key === 'networkMode' && value !== undefined) patch.networkMode = value;
        else if (key === 'languageCode' && value !== undefined) patch.languageCode = value;
        else if (key === 'privacy' && value !== undefined) {
          const next = { ...(current.privacy || {}), ...(value && typeof value === 'object' ? value : {}) };
          if (clearFingerprint) delete next.fingerprint;
          patch.privacy = next;
        }
        else if (key === 'platform' && value && typeof value === 'object') patch.platform = { ...(current.platform || {}), ...value };
        else if (key === 'advanced' && value && typeof value === 'object') patch.advanced = { ...(current.advanced || {}), ...value };
        else if (key === 'proxyMeta' && value && typeof value === 'object') patch.proxyMeta = { ...(current.proxyMeta || {}), ...value };
        else if (key === 'user_proxy_config' && value && typeof value === 'object') {
          const { proxy_type, proxy_host, proxy_port, proxy_user, proxy_password } = value;
          if (proxy_host && proxy_port) {
            const type = String(proxy_type || 'http').toLowerCase();
            patch.proxy = (type === 'socks' ? 'socks5' : type) + '://' +
              (proxy_user ? encodeURIComponent(proxy_user) + ':' + encodeURIComponent(proxy_password || '') + '@' : '') +
              proxy_host + ':' + proxy_port;
            patch.networkMode = 'proxy';
          }
        }
      else if (key === 'fingerprint' && value && typeof value === 'object') patch.fingerprint = { ...value };
        else if (key !== 'profile_id' && key !== 'user_id' && key !== 'id') patch[key] = value;
      }
      if (clearFingerprint) {
        delete patch.fingerprint;
        if (!Object.prototype.hasOwnProperty.call(patch, 'privacy')) {
          const nextPrivacy = { ...(current.privacy || {}) };
          delete nextPrivacy.fingerprint;
          patch.privacy = nextPrivacy;
        }
      }
      const next = this.engine.sanitizeProfile({ ...current, ...patch, id });
      this.normalizeProxyAssociationState(next, association);
      this.engine.profiles.set(id, next);
      if (typeof this.engine.persist === 'function') await this.engine.persist();
      const profile = this.engine.profiles.get(id);
      return ok({
        profile_id: id,
        ...proxySummary(profile, this.proxyStore, association.present ? association.value : undefined),
        profile,
      });
    }

    if (pathname === '/api/v2/browser-profile/duplicate' || pathname === '/api/profiles/duplicate') {
      if (!this.engine) return fail('profile engine unavailable');
      const sourceId = String(input.source_profile_id || input.profile_id || input.id || '');
      const source = this.engine.profiles.get(sourceId);
      if (!source) return fail('source profile not found');
      const numbers = [...this.engine.profiles.values()].map((item) => Number(item.number)).filter((n) => Number.isInteger(n) && n > 0);
      const number = (Math.max(0, ...numbers) || 0) + 1;
      const id = 'ob-' + Date.now().toString(36) + '-' + crypto.randomBytes(5).toString('hex');
      const base = this.engine.sanitizeProfile(source);
      const next = this.engine.sanitizeProfile({
        ...base,
        id,
        number,
        name: String(input.name || (base.name ? base.name + ' Copy' : 'Environment ' + number)),
        title: String(input.name || base.title || base.name || ('Environment ' + number)),
        startUrl: input.start_url !== undefined ? input.start_url : base.startUrl,
        profileId: id,
        exitCheckedAt: undefined,
        exitNetwork: undefined,
        privacy: {
          ...(base.privacy || {}),
          fingerprint: undefined,
          batterySnapshot: undefined,
          mediaLabels: undefined,
        },
      });
      await this.engine.syncProfiles([next]);
      if (typeof this.engine.persist === 'function') await this.engine.persist();
      return ok({ profile_id: id, profile: this.engine.profiles.get(id) || next });
    }

    if (pathname === '/api/v1/user/delete' || pathname === '/api/v2/browser-profile/delete' || pathname === '/api/profiles/delete') {
      if (!this.engine) return fail('profile engine unavailable');
      const rawIds = Array.isArray(input.user_ids) ? input.user_ids : (Array.isArray(input.profile_ids) ? input.profile_ids : (Array.isArray(input.ids) ? input.ids : [input.user_id || input.profile_id || input.id]));
      const ids = rawIds.map((value) => String(value || '').trim()).filter(Boolean);
      if (!ids.length) return fail('profile id required');
      let result;
      try {
        result = await this.engine.deleteProfiles(ids, input.delete_data !== false && input.deleteData !== false);
      } catch (error) {
        // e.g. isolation root validation rejection while removing profile data —
        // surface as a request error, not an internal 500.
        return fail(`delete failed: ${error.message}`, 400);
      }
      return ok(result);
    }

    if (pathname === '/api/v1/browser/start' || pathname === '/api/v2/browser-profile/start' || pathname === '/api/browser/start') {
      const id = String(input.user_id || input.profile_id || input.id || '');
      const profile = this.engine.profiles.get(id);
      if (!profile) return fail('profile not found');
      const started = await this.engine.start(profile);
      return ok({
        user_id: id,
        profile_id: id,
        debug_port: started?.port || this.engine.running.get(id)?.port || null,
        ws: {
          puppeteer: started?.port ? `http://127.0.0.1:${started.port}` : null,
        },
      });
    }

    if (pathname === '/api/v1/browser/stop' || pathname === '/api/v2/browser-profile/stop' || pathname === '/api/browser/stop') {
      const id = String(input.user_id || input.profile_id || input.id || '');
      await this.engine.stop(id);
      return ok({ user_id: id });
    }

    if (pathname === '/api/v1/browser/stop-all' || pathname === '/api/v2/browser-profile/stop-all' || pathname === '/api/browser/stop-all') {
      await this.engine.stopAll();
      return ok({ stopped: true });
    }

    if (pathname === '/api/v1/browser/active' || pathname === '/api/v2/browser-profile/active' || pathname === '/api/browser/active') {
      const active = this.engine.status().filter((item) => item.running).map((item) => ({
        user_id: item.id,
        debug_port: item.port,
        profile_directory: item.profileDirectory || null,
      }));
      return ok({ list: active });
    }

    // ---- proxy library ----
    if (pathname === '/api/v2/proxy-list/list' || pathname === '/api/proxy/list') {
      if (!this.proxyStore) return fail('proxy store unavailable');
      const list = this.proxyStore.list(input);
      return ok({ list, page: 1, page_size: list.length });
    }
    if (pathname === '/api/v2/proxy-list/create' || pathname === '/api/proxy/create') {
      if (!this.proxyStore) return fail('proxy store unavailable');
      if (Array.isArray(input) || Array.isArray(input.data)) {
        const body = Array.isArray(input) ? input : input.data;
        return ok({ list: await this.proxyStore.createMany(body) });
      }
      return ok(await this.proxyStore.create(input));
    }
    if (pathname === '/api/v2/proxy-list/update' || pathname === '/api/proxy/update') {
      if (!this.proxyStore) return fail('proxy store unavailable');
      const id = String(input.proxy_id || input.id || '');
      if (!id) return fail('id required');
      return ok(await this.proxyStore.update(id, input));
    }
    if (pathname === '/api/v2/proxy-list/delete' || pathname === '/api/proxy/delete') {
      if (!this.proxyStore) return fail('proxy store unavailable');
      const ids = Array.isArray(input.proxy_ids)
        ? input.proxy_ids
        : (Array.isArray(input.proxy_id) ? input.proxy_id : (Array.isArray(input.ids) ? input.ids : [input.id || input.proxy_id]));
      return ok(await this.proxyStore.remove(ids.filter(Boolean)));
    }
    if (pathname === '/api/proxy/check' || pathname === '/api/checkProxy') {
      if (!this.proxyStore || !this.engine) return fail('proxy check unavailable');
      const id = String(input.proxy_id || input.id || '');
      const item = id ? this.proxyStore.get(id) : null;
      const raw = item?.raw || input.proxy || input.raw;
      if (!raw) return fail('proxy required');
      const result = await this.engine.testProxy({ id: 'proxy-check', name: 'proxy-check', proxy: raw, proxyMeta: { ipChannel: item?.ipChannel || input.ipChannel || 'ip-api' } });
      if (item) await this.proxyStore.markCheck(item.id, result);
      return ok(result);
    }
    if (pathname === '/api/proxy/check-profile') {
      if (!this.engine) return fail('profile engine unavailable');
      const id = String(input.profile_id || input.user_id || input.id || '');
      const profile = this.engine.profiles.get(id);
      if (!profile) return fail('profile not found');
      const result = await this.engine.checkProxy(profile, { allowExtract: false, persist: true });
      return ok(result);
    }

    // ---- fingerprint / isolation ----
    if (pathname === '/api/fingerprint' || pathname === '/api/v1/fingerprint') {
      const id = String(input.user_id || input.profile_id || input.id || '');
      if (!id) return fail('profile_id required');
      try {
        return ok(this.engine.fingerprintFor(id));
      } catch (error) {
        return fail(error.message);
      }
    }
    if (pathname === '/api/isolation/audit' || pathname === '/api/v1/isolation/audit') {
      return ok(this.engine.isolationAudit());
    }

    // ---- application center ----
    if (pathname === '/api/v1/application/list' || pathname === '/api/application/list' || pathname === '/api/apps') {
      if (!this.appCenter) return fail('app center unavailable');
      return ok(this.appCenter.list(input));
    }
    if (pathname === '/api/application/recommended' || pathname === '/api/apps/recommended') {
      if (!this.appCenter) return fail('app center unavailable');
      return ok({ list: this.appCenter.recommended() });
    }
    if (pathname === '/api/extension/list' || pathname === '/api/extensions') {
      return ok({ list: this.engine.listExtensions() });
    }
    if (pathname === '/api/extension/assign' || pathname === '/api/extensions/assign') {
      const extensionId = String(input.extension_id || input.id || '');
      const ids = this.parseIds(input);
      const enabled = input.enabled === undefined ? true : !(input.enabled === false || input.enabled === '0' || input.enabled === 0);
      if (!extensionId || !ids.length) return fail('extension_id and profile_ids required');
      await this.engine.assignExtension(extensionId, ids, enabled);
      return ok({ extension_id: extensionId, profile_ids: ids, enabled });
    }
    if (pathname === '/api/extension/update' || pathname === '/api/getExtensionStatus') {
      return ok({ list: this.engine.listExtensions() });
    }

    // ---- window sync ----
    if (pathname === '/api/sync/status' || pathname === '/api/window-sync/status') {
      return ok(this.syncBridge.status());
    }
    if (pathname === '/api/sync/start' || pathname === '/api/window-sync/start') {
      const ids = this.parseIds(input);
      if (input.operate) this.syncBridge.updateOperateList(input.operate);
      if (input.settings) this.syncBridge.updateSettings?.(input.settings);
      const result = await this.syncBridge.start(ids, {
        tile: input.tile !== false && input.tile !== '0',
        cascade: input.cascade === true || input.cascade === '1',
        settings: input.settings,
      });
      return ok(result);
    }
    if (pathname === '/api/sync/stop' || pathname === '/api/window-sync/stop') {
      return ok(this.syncBridge.stop());
    }
    if (pathname === '/api/sync/restart' || pathname === '/api/window-sync/restart') {
      return ok(await this.syncBridge.restart());
    }
    if (pathname === '/api/sync/arrange' || pathname === '/api/window-sync/arrange') {
      const ids = this.parseIds(input);
      return ok(await this.syncBridge.arrange(ids, input.mode || 'tile'));
    }
    if (pathname === '/api/sync/settings' && method === 'GET') {
      return ok(this.syncBridge.getSettings?.() || {});
    }
    if (pathname === '/api/sync/settings' && method === 'POST') {
      return ok(this.syncBridge.updateSettings?.(input) || {});
    }

    // ---- RPA ----
    if (pathname === '/api/rpa/plans' && method === 'GET') {
      return ok({ list: this.rpaStore.listPlans() });
    }
    if (pathname === '/api/rpa/plans' && method === 'POST') {
      return ok(await this.rpaStore.upsertPlan(input));
    }
    if (pathname.startsWith('/api/rpa/plans/') && method === 'DELETE') {
      const id = pathname.split('/').pop();
      return ok(await this.rpaStore.deletePlan(id));
    }
    if (pathname === '/api/rpa/tasks' && method === 'GET') {
      const list = this.rpaStore.listTasks(input);
      const limit = Math.max(1, Math.min(500, Number(input.limit) || 50));
      return ok({ list: list.slice(0, limit), total: list.length });
    }
    if (pathname.startsWith('/api/rpa/tasks/') && method === 'GET') {
      const id = decodeURIComponent(pathname.slice('/api/rpa/tasks/'.length));
      const task = this.rpaStore.getTask(id);
      if (!task) return fail('task not found: ' + id);
      return ok({ task });
    }
    if (pathname.startsWith('/api/rpa/tasks/') && method === 'DELETE') {
      const id = decodeURIComponent(pathname.slice('/api/rpa/tasks/'.length));
      return ok(await this.rpaStore.deleteTask(id));
    }
    if (pathname === '/api/rpa/run' || pathname === '/api/rpa' || pathname === '/api/rpav2') {
      if (input.plan_id) return ok(await this.rpaEngine.runPlan(String(input.plan_id), input));
      if (input.task_id) return ok(await this.rpaEngine.runTask(String(input.task_id), input));
      if (Array.isArray(input.steps)) {
        const task = await this.rpaStore.createTask({
          profile_id: String(input.profile_id || input.user_id || ''),
          process_name: String(input.name || 'adhoc'),
          steps: input.steps,
        });
        return ok(await this.rpaEngine.runTask(task.id, input));
      }
      return fail('plan_id, task_id or steps required');
    }
    if (pathname === '/api/getRpaStatus' || pathname === '/api/rpa/status') {
      return ok({
        ...this.rpaEngine.getStatus(),
        tasks: this.rpaStore.listTasks({ status: 'running' }),
      });
    }
    if (pathname === '/api/stopRpa' || pathname === '/api/rpa/stop') {
      return ok(await this.rpaEngine.stop(input.task_id || null));
    }

    // ---- RPA template store ----
    if (pathname === '/api/rpa/templates' && method === 'GET') {
      return ok({
        list: this.rpaStore.listTemplates(input),
        categories: this.rpaStore.listTemplateCategories(),
      });
    }
    if (pathname === '/api/rpa/templates' && method === 'POST') {
      if (input.action === 'install' || input.install) {
        return ok(await this.rpaStore.installTemplate(String(input.id || input.template_id), input));
      }
      if (input.action === 'import') {
        return ok(await this.rpaStore.importTemplates(input.payload || input.data || input));
      }
      if (input.action === 'save_as' || input.save_as) {
        return ok(await this.rpaStore.saveAsTemplate(input));
      }
      return ok(await this.rpaStore.upsertTemplate(input));
    }
    if (pathname.startsWith('/api/rpa/templates/') && pathname.endsWith('/install') && method === 'POST') {
      const parts = pathname.split('/').filter(Boolean);
      const id = parts[parts.length - 2];
      return ok(await this.rpaStore.installTemplate(id, input));
    }
    if (pathname.startsWith('/api/rpa/templates/') && method === 'GET') {
      const id = pathname.split('/').filter(Boolean).pop();
      const tpl = this.rpaStore.getTemplate(id);
      if (!tpl) return fail('template not found');
      return ok(tpl);
    }
    if (pathname.startsWith('/api/rpa/templates/') && method === 'DELETE') {
      const id = pathname.split('/').filter(Boolean).pop();
      return ok(await this.rpaStore.deleteTemplate(id));
    }

    return undefined;
  }

  resolveProxyAssociation(input = {}, base = {}) {
    const association = readProxyAssociation(input);
    if (!association.present) return { present: false, patch: {} };
    if (!association.value) {
      return {
        present: true,
        value: '',
        patch: {
          proxyId: null,
          proxyMeta: { ...(base.proxyMeta || {}), proxyId: null },
        },
      };
    }
    if (!this.proxyStore) {
      const error = new Error('proxy store unavailable');
      error.statusCode = 503;
      throw error;
    }
    const item = this.proxyStore.get(association.value);
    if (!item) {
      const error = new Error('proxy library entry not found: ' + association.value);
      error.statusCode = 404;
      throw error;
    }
    return {
      present: true,
      value: item.id,
      item,
      patch: {
        proxyId: item.id,
        proxy: item.raw,
        networkMode: 'proxy',
        proxyMeta: {
          ...(base.proxyMeta || {}),
          proxyId: item.id,
          ipChannel: item.ipChannel || base.proxyMeta?.ipChannel || 'ip-api',
        },
      },
    };
  }

  normalizeProxyAssociationState(profile, association) {
    if (!profile || !association?.present) return profile;
    for (const key of ['proxy_id', 'proxy_library_id', 'proxyIdAlias', 'proxyLibraryId']) delete profile[key];
    const proxyId = association.value || null;
    profile.proxyId = proxyId;
    const proxyMeta = profile.proxyMeta && typeof profile.proxyMeta === 'object' ? { ...profile.proxyMeta } : {};
    delete proxyMeta.proxy_id;
    delete proxyMeta.proxy_library_id;
    delete proxyMeta.proxyLibraryId;
    proxyMeta.proxyId = proxyId;
    profile.proxyMeta = proxyMeta;
    return profile;
  }

  parseIds(input) {
    const { assertProfileId } = require('./isolation');
    let ids = [];
    if (Array.isArray(input.profile_ids)) ids = input.profile_ids;
    else if (Array.isArray(input.ids)) ids = input.ids;
    else if (Array.isArray(input.user_ids)) ids = input.user_ids;
    else if (input.handles) ids = String(input.handles).split(',').map((s) => s.trim()).filter(Boolean);
    else if (input.user_id) ids = [input.user_id];
    else if (input.profile_id) ids = [input.profile_id];
    if (ids.length > 200) throw new Error('Invalid profile selection');
    return [...new Set(ids.map((id) => assertProfileId(String(id))))];
  }
}

module.exports = { LocalApiServer };
