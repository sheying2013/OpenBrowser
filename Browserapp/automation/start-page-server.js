'use strict';

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');
const { buildStartPageHtml } = require('./start-page-template');

/**
 * OpenBrowser · 原生启动页服务（纯本机，不依赖 ixBrowser / Ads / 其它客户端）
 *
 * 浏览器打开：
   *   http://127.0.0.1:<port>/?pid=<profileId>&token=<random-session-token>
 *
 * 数据来源：
 *   1) 主进程启动环境时 registerSession 写入的 profile + network
 *   2) 同端口 /api/session · /api/network 只读本机会话（可选刷新走 engine.checkProxy）
 * 页面 JS 只请求 127.0.0.1，不直接请求第三方。
 */

const DEFAULT_PORT = Number(process.env.OPENBROWSER_START_PAGE_PORT || 50326);
// 不使用 52826（ixBrowser 占用），只用 OpenBrowser 的端口池
const PORT_CANDIDATES = [DEFAULT_PORT, 50327, 50328, 50329, 0];
const REACHABILITY_TARGETS = {
  google: 'https://www.google.com/generate_204',
  youtube: 'https://www.youtube.com/generate_204',
  tiktok: 'https://www.tiktok.com/favicon.ico',
  x: 'https://x.com/favicon.ico',
  chatgpt: 'https://chatgpt.com/favicon.ico',
  wikipedia: 'https://www.wikipedia.org/favicon.ico',
};

function lookupDirectNetwork(timeout = 10000) {
  return new Promise((resolve, reject) => {
    const request = http.get({
      hostname: 'ip-api.com',
      path: '/json/?fields=status,message,country,countryCode,regionName,city,zip,timezone,lat,lon,isp,org,as,asname,mobile,proxy,hosting,query',
      headers: { Accept: 'application/json', 'User-Agent': 'OpenBrowser/1.0' },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.once('end', () => {
        try {
          if (response.statusCode !== 200) throw new Error(`出口检测返回 HTTP ${response.statusCode}`);
          const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (value.status !== 'success' || !value.query) throw new Error(value.message || '出口检测响应不完整');
          resolve({
            ip: String(value.query),
            country: String(value.country || ''),
            countryCode: String(value.countryCode || '').toUpperCase(),
            region: String(value.regionName || ''),
            city: String(value.city || ''),
            zip: String(value.zip || ''),
            timezone: String(value.timezone || ''),
            latitude: Number.isFinite(Number(value.lat)) ? Number(value.lat) : null,
            longitude: Number.isFinite(Number(value.lon)) ? Number(value.lon) : null,
            isp: String(value.isp || ''),
            organization: String(value.org || ''),
            asn: String(value.as || '').split(/\s+/, 1)[0],
            asName: String(value.asname || ''),
            mobile: Boolean(value.mobile),
            proxy: Boolean(value.proxy),
            hosting: Boolean(value.hosting),
            checkedAt: new Date().toISOString(),
            protocol: 'direct',
          });
        } catch (error) { reject(error); }
      });
    });
    request.setTimeout(timeout, () => request.destroy(new Error('出口检测超时')));
    request.once('error', reject);
  });
}

function probeReachability(url, timeout = 6000) {
  return new Promise((resolve) => {
    let parsed;
    try { parsed = new URL(url); } catch (error) { resolve({ ok: false, status: 0, error: 'invalid url' }); return; }
    const transport = parsed.protocol === 'https:' ? https : http;
    const request = transport.request({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: `${parsed.pathname || '/'}${parsed.search || ''}`,
      method: 'GET',
      headers: { 'User-Agent': 'OpenBrowser/1.0', Accept: '*/*' },
    }, (response) => {
      response.resume();
      response.once('end', () => resolve({ ok: response.statusCode >= 200 && response.statusCode < 500, status: response.statusCode || 0 }));
    });
    request.setTimeout(timeout, () => request.destroy(new Error('timeout')));
    request.once('error', (error) => resolve({ ok: false, status: 0, error: error.message }));
    request.end();
  });
}

async function lookupReachability(timeout = 6000) {
  const entries = await Promise.all(Object.entries(REACHABILITY_TARGETS).map(async ([id, url]) => {
    const result = await probeReachability(url, timeout);
    return [id, { id, url, ...result }];
  }));
  return Object.fromEntries(entries);
}

function formatTime(ts) {
  const n = Number(ts);
  const d = Number.isFinite(n) && n > 1e9
    ? new Date(n > 1e12 ? n : n * 1000)
    : new Date();
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function proxyEndpoint(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw.includes('://') ? raw : `http://${raw}`);
    return `${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}`;
  } catch (_) {
    return raw.replace(/^[^@]*@/, '').slice(0, 160);
  }
}

class StartPageServer {
  constructor(options = {}) {
    this.host = options.host || '127.0.0.1';
    this.preferredPort = Number(options.port) || DEFAULT_PORT;
    this.port = null;
    this.server = null;
    /** @type {Map<string, object>} profileId -> session payload */
    this.sessions = new Map();
    /** optional BrowserEngine for network refresh */
    this.engine = options.engine || null;
    this.lookupDirectNetwork = options.lookupDirectNetwork || lookupDirectNetwork;
    this.lookupReachability = options.lookupReachability || lookupReachability;
  }

  setEngine(engine) {
    this.engine = engine || null;
  }

  isStartPageUrl(url) {
    const s = String(url || '').toLowerCase();
    if (!s) return false;
    if (s.includes('openbrowser-start.html')) return true;
    if (s.includes('openbrowser-start-page') || s.includes('openbrowser-native')) return true;
    if (this.port) {
      return s.startsWith(`http://127.0.0.1:${this.port}/`)
        || s.startsWith(`http://localhost:${this.port}/`);
    }
    return /https?:\/\/127\.0\.0\.1:5032[6-9]\/?/.test(s);
  }

  /**
   * Register a profile session and return native start URL.
   */
  registerSession(profile = {}, extras = {}) {
    if (!this.port) throw new Error('启动页服务未启动');
    const profileId = String(profile.id || '');
    const serial = String(profile.number || profile.serial || extras.serial || profileId);
    const network = extras.network || profile.network || null;
    const timezone = extras.timezone
      || profile.exitTimezone
      || network?.timezone
      || (profile.privacy?.timezoneMode === 'custom' ? profile.privacy.timezone : '')
      || '';

    const session = {
      pid: profileId,
      profileId,
      id: serial,
      serial,
      number: serial,
      name: String(profile.name || ''),
      username: String(profile.username || profile.account || extras.username || ''),
      tfa_secret: String(profile.tfa_secret || profile.tfaSecret || extras.tfa_secret || ''),
      note: String(profile.note || ''),
      group_name: String(profile.group_name || profile.group || extras.group_name || ''),
      tag_name: String(profile.tag || profile.tag_name || ''),
      language: String(profile.language || ''),
      userAgent: String(profile.userAgent || extras.userAgent || ''),
      timezone,
      exitTimezone: timezone,
      exitIp: network?.ip || profile.exitIp || '',
      countryCode: network?.countryCode || profile.exitCountryCode || '',
      network: network ? { ...network } : null,
      time: Number(extras.time) || Math.floor(Date.now() / 1000),
      startedAtLabel: formatTime(extras.time || Date.now() / 1000),
      browserName: extras.browserName || '',
      extensionCount: extras.extensionCount || 0,
      networkMode: profile.networkMode === 'direct' || !profile.proxy || /^(direct|offline|none)$/i.test(String(profile.proxy)) ? 'direct' : 'proxy',
      proxyProtocol: profile.networkMode === 'direct' || !profile.proxy || /^(direct|offline|none)$/i.test(String(profile.proxy))
        ? 'direct'
        : String(profile.proxy).split(':', 1)[0].toLowerCase(),
      expectedFingerprint: {
        language: String(profile.language || ''),
        userAgent: String(profile.userAgent || extras.userAgent || ''),
        timezone,
        screenWidth: Number(profile.width) || null,
        screenHeight: Number(profile.height) || null,
        webrtc: String(profile.privacy?.webrtc || ''),
        canvas: String(profile.privacy?.canvas || ''),
        webgl: String(profile.privacy?.webgl || ''),
        audio: String(profile.privacy?.audio || ''),
        hardwareConcurrency: Number(profile.privacy?.fingerprint?.hardwareConcurrency || profile.privacy?.cores) || null,
        deviceMemory: Number(profile.privacy?.fingerprint?.deviceMemory || profile.privacy?.memory) || null,
      },
      token: crypto.randomBytes(24).toString('base64url'),
      at: Date.now(),
    };

    if (profileId) this.sessions.set(profileId, session);
    // also index by serial for query-only access
    if (serial && serial !== profileId) this.sessions.set('serial:' + serial, session);

    const params = new URLSearchParams();
    params.set('pid', profileId || serial);
    params.set('id', serial);
    params.set('token', session.token);
    // soft branding for tab title before HTML loads
    params.set('soft', 'openbrowser');

    const url = `http://127.0.0.1:${this.port}/?${params.toString()}`;
    session.url = url;
    return url;
  }

  getSession(pid) {
    if (!pid) return null;
    const key = String(pid);
    return this.sessions.get(key)
      || this.sessions.get('serial:' + key)
      || null;
  }

  updateNetwork(pid, network) {
    const session = this.getSession(pid);
    if (!session || !network) return session;
    session.network = { ...network };
    session.exitIp = network.ip || session.exitIp;
    session.countryCode = network.countryCode || session.countryCode;
    if (network.timezone) session.timezone = network.timezone;
    session.at = Date.now();
    return session;
  }

  buildUrl(profile = {}, extras = {}) {
    return this.registerSession(profile, extras);
  }

  async start() {
    if (this.server) return this.info();
    const ports = [this.preferredPort, ...PORT_CANDIDATES.filter((p) => p !== this.preferredPort)];
    let lastError;
    for (const candidate of ports) {
      try {
        await this.#listen(candidate);
        return this.info();
      } catch (error) {
        lastError = error;
        this.server = null;
      }
    }
    throw lastError || new Error('无法绑定 OpenBrowser 启动页端口');
  }

  #listen(port) {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        this.#handle(req, res).catch((error) => {
          try {
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, msg: error.message }));
          } catch (_) {}
        });
      });
      const onError = (error) => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        this.server = server;
        this.port = server.address().port;
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, this.host);
    });
  }

  async stop() {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    this.port = null;
    await new Promise((resolve) => server.close(() => resolve()));
  }

  info() {
    return {
      host: this.host,
      port: this.port,
      url: this.port ? `http://${this.host}:${this.port}/` : null,
      soft: 'OpenBrowser',
      native: true,
    };
  }

  #parse(reqUrl) {
    try {
      const u = new URL(reqUrl, `http://${this.host}:${this.port || 80}`);
      const q = {};
      for (const [k, v] of u.searchParams.entries()) q[k] = v;
      return { pathname: u.pathname, query: q };
    } catch (_) {
      return { pathname: '/', query: {} };
    }
  }

  #json(res, code, body) {
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(JSON.stringify(body));
  }

  async #resolveNetwork(pid, refresh) {
    let session = this.getSession(pid);
    // hydrate from engine if possible
    if (this.engine && pid) {
      const profile = this.engine.profiles?.get?.(String(pid));
      const runningNet = this.engine.networkInfo?.get?.(String(pid));
      if (!session && profile) {
        this.registerSession(profile, { network: runningNet || null });
        session = this.getSession(pid);
      }
      if (refresh && profile) {
        try {
          const isDirect = profile.networkMode === 'direct'
            || !profile.proxy
            || /^(direct|offline|none)$/i.test(String(profile.proxy));
          const network = isDirect
            ? await this.lookupDirectNetwork()
            : await this.engine.checkProxy(profile);
          if (isDirect) this.engine.networkInfo?.set?.(String(pid), network);
          this.updateNetwork(pid, network);
          return network;
        } catch (error) {
          if (session?.network) return session.network;
          const endpoint = proxyEndpoint(profile.proxy);
          throw new Error(endpoint
            ? `代理 ${endpoint} 出口检测失败：${error.message}`
            : `出口检测失败：${error.message}`);
        }
      }
      if (runningNet) {
        this.updateNetwork(pid, runningNet);
        return runningNet;
      }
    }
    // 旧启动页链接可能在应用重启后失去会话。此时仍允许按当前机器直连检测，
    // 但已知代理配置的失败必须在上面的代理分支中原样返回。
    if (refresh && !session) return this.lookupDirectNetwork();
    if (session?.network) return session.network;
    if (session?.exitIp) {
      return {
        ip: session.exitIp,
        countryCode: session.countryCode || '',
        timezone: session.timezone || '',
      };
    }
    return null;
  }

  async #handle(req, res) {
    const { pathname, query } = this.#parse(req.url || '/');
    const expectedOrigin = `http://127.0.0.1:${this.port}`;
    const origin = String(req.headers.origin || '');
    if (origin && origin !== expectedOrigin && origin !== `http://localhost:${this.port}`) {
      return this.#json(res, 403, { ok: false, msg: 'forbidden origin' });
    }

    if (pathname === '/health' || pathname === '/api/health') {
      return this.#json(res, 200, {
        ok: true,
        soft: 'OpenBrowser',
        native: true,
        port: this.port,
      });
    }

    const pid = query.pid || query.id || '';
    const session = this.getSession(pid);
    const token = String(query.token || req.headers['x-openbrowser-start-token'] || '');
    const authorized = Boolean(session && token && token.length === session.token.length
      && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(session.token)));

    if ((pathname.startsWith('/api/') || pathname === '/' || pathname === '/index.html' || pathname === '/start') && !authorized) {
      return this.#json(res, 401, { ok: false, msg: 'unauthorized session' });
    }

    if (pathname === '/api/session') {
      const data = { ...session };
      delete data.token;
      delete data.url;
      return this.#json(res, 200, { ok: true, data, pid });
    }

    if (pathname === '/api/network') {
      const refresh = query.refresh === '1' || query.refresh === 'true';
      try {
        const network = await this.#resolveNetwork(pid, refresh);
        if (!network) return this.#json(res, 404, { ok: false, msg: 'network not found', pid });
        return this.#json(res, 200, { ok: true, data: network });
      } catch (error) {
        return this.#json(res, 500, { ok: false, msg: error.message });
      }
    }

    if (pathname === '/api/reachability') {
      const data = await this.lookupReachability();
      return this.#json(res, 200, { ok: true, data });
    }

    if (pathname === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (pathname === '/' || pathname === '/index.html' || pathname === '/start') {
      let data = session || {};
      data = {
        ...data,
        pid: data.pid || pid,
      };
      delete data.token;
      delete data.url;
      const html = buildStartPageHtml(data);
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'X-OpenBrowser-Start-Page': 'native',
      });
      res.end(html);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found · OpenBrowser 启动页');
  }
}

let singleton = null;

async function ensureStartPageServer(options = {}) {
  if (singleton?.server) {
    if (options.engine) singleton.setEngine(options.engine);
    return singleton;
  }
  singleton = new StartPageServer(options);
  if (options.engine) singleton.setEngine(options.engine);
  await singleton.start();
  return singleton;
}

function getStartPageServer() {
  return singleton;
}

module.exports = {
  StartPageServer,
  ensureStartPageServer,
  getStartPageServer,
  buildStartPageHtml,
  lookupDirectNetwork,
  lookupReachability,
  DEFAULT_PORT,
};
