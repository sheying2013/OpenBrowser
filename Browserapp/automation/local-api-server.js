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

/**
 * Local HTTP API for OpenBrowser control plane.
 * Response envelope uses {code,msg,data}.
 */
class LocalApiServer {
  constructor(options = {}) {
    this.host = options.host || '127.0.0.1';
    this.port = Number(options.port) || 50325;
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

  authOk(req) {
    const headerKey = req.headers['api-key'] || req.headers['x-api-key'] || '';
    const auth = String(req.headers.authorization || '');
    const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
    const supplied = String(headerKey || bearer || '');
    if (!supplied || supplied.length !== this.apiKey.length) return false;
    return crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(this.apiKey));
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
      this.server.listen(this.port, this.host, () => {
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

      if (!this.authOk(req)) {
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
      }));
      return ok({ list, page: 1, page_size: list.length });
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

    if (pathname === '/api/v2/browser-profile/stop-all' || pathname === '/api/browser/stop-all') {
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
      const ids = Array.isArray(input.proxy_id) ? input.proxy_id : (Array.isArray(input.ids) ? input.ids : [input.id || input.proxy_id]);
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
      return ok({ list: this.rpaStore.listTasks(input) });
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
