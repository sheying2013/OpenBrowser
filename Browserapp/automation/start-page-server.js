'use strict';

const http = require('http');
const https = require('https');
const tls = require('tls');
const net = require('net');
const crypto = require('crypto');
const { URL } = require('url');
const { buildStartPageHtml } = require('./start-page-template');
const { lookupDirectCountry, parseProxy, startAuthenticatedProxy } = require('../proxy-forwarder');

/**
 * OpenBrowser · 原生启动页服务（纯本机）
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
const PORT_CANDIDATES = [DEFAULT_PORT, 50327, 50328, 50329, 0];
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** 访问能力探测目标：连通 + 出口地区 + best-effort 解锁信号 */
const REACHABILITY_TARGETS = {
  google: {
    label: 'Google',
    kind: 'connectivity',
    url: 'https://www.google.com/generate_204',
  },
  youtube: {
    label: 'YouTube',
    kind: 'connectivity',
    url: 'https://www.youtube.com/generate_204',
    unlockUrl: 'https://www.youtube.com/',
  },
  tiktok: {
    label: 'TikTok',
    kind: 'connectivity',
    url: 'https://www.tiktok.com/favicon.ico',
  },
  x: {
    label: 'X / Twitter',
    kind: 'cf-trace',
    url: 'https://x.com/cdn-cgi/trace',
  },
  chatgpt: {
    label: 'ChatGPT',
    kind: 'cf-trace',
    url: 'https://chatgpt.com/cdn-cgi/trace',
    unlockUrl: 'https://chatgpt.com/',
  },
  wikipedia: {
    label: 'Wikipedia',
    kind: 'connectivity',
    url: 'https://www.wikipedia.org/favicon.ico',
  },
  facebook: {
    label: 'Facebook',
    kind: 'meta',
    url: 'https://www.facebook.com/',
  },
  instagram: {
    label: 'Instagram',
    kind: 'meta',
    url: 'https://www.instagram.com/',
  },
  reddit: {
    label: 'Reddit',
    kind: 'reddit',
    url: 'https://www.reddit.com/',
  },
};

const COUNTRY_NAMES = {
  US: '美国', JP: '日本', GB: '英国', UK: '英国', HK: '香港', TW: '台湾', CN: '中国',
  SG: '新加坡', KR: '韩国', DE: '德国', FR: '法国', CA: '加拿大', AU: '澳大利亚',
  NL: '荷兰', IE: '爱尔兰', IN: '印度', BR: '巴西', RU: '俄罗斯', TH: '泰国',
  VN: '越南', MY: '马来西亚', PH: '菲律宾', ID: '印度尼西亚', MX: '墨西哥',
  IT: '意大利', ES: '西班牙', SE: '瑞典', CH: '瑞士', AE: '阿联酋', TR: '土耳其',
};

function countryLabel(code, fallback = '') {
  const cc = String(code || '').toUpperCase();
  if (!cc) return fallback || '';
  return COUNTRY_NAMES[cc] ? `${COUNTRY_NAMES[cc]}（${cc}）` : cc;
}

async function lookupDirectNetwork() {
  const network = await lookupDirectCountry();
  return {
    ...network,
    protocol: 'direct',
  };
}

function parseCfTrace(body = '') {
  const text = String(body || '');
  const pick = (key) => {
    const match = text.match(new RegExp(`(?:^|\\n)${key}=([^\\n\\r]+)`, 'i'));
    return match ? String(match[1]).trim() : '';
  };
  const ip = pick('ip');
  const loc = pick('loc').toUpperCase();
  const colo = pick('colo');
  return {
    ip: ip || '',
    countryCode: /^[A-Z]{2}$/.test(loc) ? loc : '',
    colo: colo || '',
  };
}

function looksBlocked(body = '', status = 0) {
  const text = String(body || '');
  if (status === 403 || status === 451) return true;
  return /just a moment|attention required|access denied|not available in your (country|region)|unsupported.?country|vpn|proxy detected|sorry, you have been blocked|title>\s*blocked\s*</i.test(text);
}

function looksUnlockedMeta(body = '', status = 0) {
  if (status >= 200 && status < 400) {
    if (looksBlocked(body, status)) return false;
    // Meta 常见正常页特征；400 错误页不算解锁
    if (status === 400) return false;
    return /facebook|instagram|meta/i.test(body) || body.length > 200;
  }
  return false;
}

function classifyUnlock(kind, status, body, cf) {
  const blocked = looksBlocked(body, status);
  if (kind === 'cf-trace') {
    if (cf?.ip || cf?.countryCode) {
      return blocked ? 'blocked' : 'unlocked';
    }
    if (status >= 200 && status < 400 && !blocked) return 'reachable';
    if (blocked || status === 403 || status === 451) return 'blocked';
    return status ? 'unreachable' : 'unreachable';
  }
  if (kind === 'reddit') {
    if (blocked || /title>\s*blocked\s*</i.test(String(body || '')) || status === 403) return 'blocked';
    if (status >= 200 && status < 400) return 'unlocked';
    return status ? 'unreachable' : 'unreachable';
  }
  if (kind === 'meta') {
    if (blocked || status === 403 || status === 451 || status === 400) return 'blocked';
    if (looksUnlockedMeta(body, status)) return 'unlocked';
    if (status >= 200 && status < 400) return 'reachable';
    return 'unreachable';
  }
  // connectivity / default
  if (status >= 200 && status < 500 && !blocked) return 'reachable';
  if (blocked) return 'blocked';
  return 'unreachable';
}

function readHttpResponse(socket, timeout, maxBody = 65536) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch (_) {}
      reject(new Error('timeout'));
    }, timeout);
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(value);
    };
    socket.on('data', (chunk) => {
      chunks.push(chunk);
      const total = Buffer.concat(chunks);
      if (total.length > maxBody + 8192) {
        try { socket.destroy(); } catch (_) {}
      }
    });
    socket.once('error', (error) => finish(error));
    socket.once('end', () => {
      try {
        const response = Buffer.concat(chunks);
        const marker = response.indexOf('\r\n\r\n');
        if (marker < 0) return finish(new Error('invalid response'));
        const header = response.subarray(0, marker).toString('latin1');
        const status = Number(header.split('\r\n', 1)[0].match(/\s(\d{3})(?:\s|$)/)?.[1] || 0);
        let body = response.subarray(marker + 4);
        if (body.length > maxBody) body = body.subarray(0, maxBody);
        finish(null, { status, header, body: body.toString('utf8') });
      } catch (error) {
        finish(error);
      }
    });
  });
}

async function connectProxyTunnel(bridge, hostname, port, timeout = 8000) {
  const socket = net.connect({ host: '127.0.0.1', port: bridge.port });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('proxy connect timeout')), timeout);
    socket.once('connect', () => { clearTimeout(timer); resolve(); });
    socket.once('error', (error) => { clearTimeout(timer); reject(error); });
  });
  if (bridge.protocol === 'http') {
    socket.write(`CONNECT ${hostname}:${port} HTTP/1.1\r\nHost: ${hostname}:${port}\r\nConnection: keep-alive\r\n\r\n`);
    const head = await new Promise((resolve, reject) => {
      let buf = Buffer.alloc(0);
      const timer = setTimeout(() => reject(new Error('proxy CONNECT timeout')), timeout);
      const onData = (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        const idx = buf.indexOf('\r\n\r\n');
        if (idx >= 0) {
          clearTimeout(timer);
          socket.off('data', onData);
          socket.pause();
          const leftover = buf.subarray(idx + 4);
          resolve({ header: buf.subarray(0, idx).toString('latin1'), leftover });
        }
      };
      socket.on('data', onData);
      socket.once('error', (error) => { clearTimeout(timer); reject(error); });
    });
    const status = Number(head.header.split('\r\n', 1)[0].match(/\s(\d{3})(?:\s|$)/)?.[1] || 0);
    if (status !== 200) {
      socket.destroy();
      throw new Error('proxy CONNECT HTTP ' + status);
    }
    if (head.leftover.length) socket.unshift(head.leftover);
    socket.resume();
  } else {
    // local auth bridge for socks is HTTP-facing in OpenBrowser; if not, fail soft
    socket.destroy();
    throw new Error('unsupported local bridge protocol for site probe');
  }
  return socket;
}

function probeDirect(url, timeout = 8000, maxBody = 65536) {
  return new Promise((resolve) => {
    let parsed;
    try { parsed = new URL(url); } catch (error) {
      resolve({ ok: false, status: 0, error: 'invalid url', body: '' });
      return;
    }
    const transport = parsed.protocol === 'https:' ? https : http;
    const request = transport.request({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: `${parsed.pathname || '/'}${parsed.search || ''}`,
      method: 'GET',
      headers: {
        'User-Agent': BROWSER_UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'identity',
        Connection: 'close',
      },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => {
        if (Buffer.concat(chunks).length < maxBody) chunks.push(chunk);
      });
      response.once('end', () => {
        resolve({
          ok: response.statusCode >= 200 && response.statusCode < 500,
          status: response.statusCode || 0,
          body: Buffer.concat(chunks).toString('utf8'),
          headers: response.headers || {},
        });
      });
    });
    request.setTimeout(timeout, () => request.destroy(new Error('timeout')));
    request.once('error', (error) => resolve({ ok: false, status: 0, error: error.message, body: '' }));
    request.end();
  });
}

async function probeViaProxy(proxyRaw, url, timeout = 8000, maxBody = 65536) {
  let config;
  try { config = parseProxy(proxyRaw); } catch (error) {
    return { ok: false, status: 0, error: error.message, body: '' };
  }
  if (!config) return { ok: false, status: 0, error: 'invalid proxy', body: '' };
  let bridge;
  let socket;
  let secure;
  try {
    const parsed = new URL(url);
    const port = Number(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80);
    bridge = await startAuthenticatedProxy(config);
    socket = await connectProxyTunnel(bridge, parsed.hostname, port, timeout);
    const path = `${parsed.pathname || '/'}${parsed.search || ''}`;
    const payload = [
      `GET ${path} HTTP/1.1`,
      `Host: ${parsed.hostname}`,
      `User-Agent: ${BROWSER_UA}`,
      'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language: en-US,en;q=0.9',
      'Accept-Encoding: identity',
      'Connection: close',
      '',
      '',
    ].join('\r\n');
    if (parsed.protocol === 'https:') {
      secure = tls.connect({
        socket,
        servername: parsed.hostname,
        rejectUnauthorized: false,
        ALPNProtocols: ['http/1.1'],
      });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('tls timeout')), timeout);
        secure.once('secureConnect', () => { clearTimeout(timer); resolve(); });
        secure.once('error', (error) => { clearTimeout(timer); reject(error); });
      });
      secure.write(payload);
      const response = await readHttpResponse(secure, timeout, maxBody);
      return {
        ok: response.status >= 200 && response.status < 500,
        status: response.status,
        body: response.body,
      };
    }
    socket.write(payload);
    const response = await readHttpResponse(socket, timeout, maxBody);
    return {
      ok: response.status >= 200 && response.status < 500,
      status: response.status,
      body: response.body,
    };
  } catch (error) {
    return { ok: false, status: 0, error: error.message, body: '' };
  } finally {
    try { secure?.destroy(); } catch (_) {}
    try { socket?.destroy(); } catch (_) {}
    try { await bridge?.close?.(); } catch (_) {}
  }
}

async function probeTarget(target, options = {}) {
  const timeout = Number(options.timeout) || 8000;
  const proxyRaw = options.proxy || '';
  const exitNetwork = options.exitNetwork || null;
  const primary = await (proxyRaw
    ? probeViaProxy(proxyRaw, target.url, timeout)
    : probeDirect(target.url, timeout));

  let unlockProbe = null;
  if (target.unlockUrl && primary.ok) {
    unlockProbe = await (proxyRaw
      ? probeViaProxy(proxyRaw, target.unlockUrl, timeout)
      : probeDirect(target.unlockUrl, timeout));
  }

  const bodyForClass = unlockProbe?.body || primary.body || '';
  const statusForClass = unlockProbe?.status || primary.status || 0;
  const cf = target.kind === 'cf-trace' ? parseCfTrace(primary.body || '') : null;
  const unlock = classifyUnlock(
    target.kind,
    statusForClass || primary.status || 0,
    bodyForClass,
    cf
  );

  const siteIp = cf?.ip || '';
  const siteCountryCode = cf?.countryCode || '';
  const exitIp = exitNetwork?.ip || '';
  const exitCountryCode = String(exitNetwork?.countryCode || '').toUpperCase();
  const accessIp = siteIp || exitIp || '';
  const accessCountryCode = siteCountryCode || exitCountryCode || '';

  return {
    id: target.id,
    label: target.label,
    kind: target.kind,
    url: target.url,
    ok: Boolean(primary.ok || (primary.status >= 200 && primary.status < 500)),
    status: primary.status || 0,
    error: primary.error || '',
    unlock,
    exitIp,
    exitCountryCode,
    exitCountry: countryLabel(exitCountryCode, exitNetwork?.country || ''),
    siteIp,
    siteCountryCode,
    siteCountry: countryLabel(siteCountryCode),
    accessIp,
    accessCountryCode,
    accessCountry: countryLabel(accessCountryCode),
    colo: cf?.colo || '',
    viaProxy: Boolean(proxyRaw),
  };
}

async function lookupReachability(options = {}) {
  const timeout = Number(options.timeout) || 8000;
  const proxy = options.proxy || '';
  const exitNetwork = options.exitNetwork || null;
  const entries = await Promise.all(Object.entries(REACHABILITY_TARGETS).map(async ([id, meta]) => {
    const result = await probeTarget({ id, ...meta }, { timeout, proxy, exitNetwork });
    return [id, result];
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
        const isDirect = profile.networkMode === 'direct'
          || !profile.proxy
          || /^(direct|offline|none)$/i.test(String(profile.proxy));
        try {
          const network = isDirect
            ? await this.lookupDirectNetwork()
            : await this.engine.checkProxy(profile);
          if (isDirect) this.engine.networkInfo?.set?.(String(pid), network);
          this.updateNetwork(pid, network);
          return network;
        } catch (error) {
          if (session?.network?.ip) return session.network;
          if (isDirect) {
            // Direct mode is still valid local exit; geo is best-effort only.
            const soft = {
              ip: session?.exitIp || profile.exitIp || '',
              country: '',
              countryCode: session?.countryCode || profile.exitCountryCode || '',
              region: '',
              city: '',
              timezone: session?.timezone || profile.exitTimezone || '',
              latitude: profile.exitLatitude ?? null,
              longitude: profile.exitLongitude ?? null,
              protocol: 'direct',
              soft: true,
              checkedAt: new Date().toISOString(),
            };
            this.updateNetwork(pid, soft);
            return soft;
          }
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
    if (refresh && !session) {
      try {
        return await this.lookupDirectNetwork();
      } catch (_) {
        return {
          ip: '',
          country: '',
          countryCode: '',
          region: '',
          city: '',
          timezone: '',
          protocol: 'direct',
          soft: true,
          checkedAt: new Date().toISOString(),
        };
      }
    }
    if (session?.network) return session.network;
    if (session?.exitIp) {
      return {
        ip: session.exitIp,
        countryCode: session.countryCode || '',
        timezone: session.timezone || '',
        protocol: session.networkMode === 'direct' || session.proxyProtocol === 'direct' ? 'direct' : undefined,
      };
    }
    if (session && (session.networkMode === 'direct' || session.proxyProtocol === 'direct')) {
      return {
        ip: '',
        countryCode: session.countryCode || '',
        timezone: session.timezone || '',
        protocol: 'direct',
        soft: true,
        checkedAt: new Date().toISOString(),
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
    let session = this.getSession(pid);
    const token = String(query.token || req.headers['x-openbrowser-start-token'] || '');
    let authorized = Boolean(session && token && token.length === session.token.length
      && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(session.token)));

    // Running env but stale token (OpenBrowser restarted, or old bookmark): re-bind session and redirect.
    if (!authorized && pid && this.engine?.running?.has?.(pid)
      && (pathname === '/' || pathname === '/index.html' || pathname === '/start')) {
      try {
        const item = this.engine.running.get(pid);
        const profile = item?.profile || { id: pid, name: pid, number: query.id || pid };
        const freshUrl = this.registerSession(profile, {
          network: item?.network || this.engine.networkInfo?.get?.(pid) || null,
          browserName: item?.browser?.name || '',
          extensionCount: Array.isArray(item?.extensions) ? item.extensions.length : 0,
        });
        res.writeHead(302, {
          Location: freshUrl,
          'Cache-Control': 'no-store',
          'X-OpenBrowser-Start-Page': 'reissued',
        });
        res.end();
        return;
      } catch (_) { /* fall through to unauthorized */ }
    }

    session = this.getSession(pid);
    authorized = Boolean(session && token && token.length === session.token.length
      && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(session.token)));

    if ((pathname.startsWith('/api/') || pathname === '/' || pathname === '/index.html' || pathname === '/start') && !authorized) {
      // Browser navigations get HTML (JSON looks like "page won't open"); APIs stay JSON.
      const accept = String(req.headers.accept || '');
      const wantsHtml = !pathname.startsWith('/api/') && !/application\/json/i.test(accept);
      if (wantsHtml) {
        const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>启动页会话无效</title>
<style>body{margin:0;font-family:system-ui,sans-serif;background:#12141a;color:#e8eaf0;display:grid;place-items:center;min-height:100vh}
.card{max-width:520px;padding:28px 24px;border-radius:14px;background:#1c1f28;border:1px solid #2a3040;line-height:1.7}
h1{margin:0 0 12px;font-size:20px}p{margin:8px 0;color:#b7becc}code{color:#93c5fd}</style></head>
<body><div class="card">
<h1>OpenBrowser 启动页会话无效</h1>
<p>这个内部首页需要<strong>当次启动</strong>签发的 token，不能收藏后重复打开，也不能在 OpenBrowser 重启后继续用旧链接。</p>
<p>请回到 OpenBrowser 客户端，<strong>停止环境后重新启动</strong>；不要手动粘贴旧的 <code>127.0.0.1:50326</code> 链接。</p>
<p style="font-size:12px;color:#8b93a7">pid=${String(pid || '-')} · unauthorized session</p>
</div></body></html>`;
        res.writeHead(401, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-OpenBrowser-Start-Page': 'unauthorized',
        });
        res.end(html);
        return;
      }
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
      let exitNetwork = session?.network || null;
      let proxy = '';
      const profile = this.engine?.profiles?.get?.(String(pid));
      if (this.engine && pid) {
        exitNetwork = this.engine.networkInfo?.get?.(String(pid)) || exitNetwork;
        if (!exitNetwork) {
          try { exitNetwork = await this.#resolveNetwork(pid, false); } catch (_) {}
        }
        if (profile) {
          const isDirect = profile.networkMode === 'direct'
            || !profile.proxy
            || /^(direct|offline|none)$/i.test(String(profile.proxy));
          if (!isDirect) proxy = String(profile.proxy || '');
        } else if (session?.networkMode === 'proxy' && session?.proxyProtocol && session.proxyProtocol !== 'direct') {
          // session alone may not hold full proxy URL; leave direct probe
          proxy = '';
        }
      }
      try {
        const data = await this.lookupReachability({
          proxy,
          exitNetwork: exitNetwork || {
            ip: session?.exitIp || '',
            countryCode: session?.countryCode || '',
            country: '',
          },
        });
        return this.#json(res, 200, {
          ok: true,
          data,
          meta: {
            exitIp: exitNetwork?.ip || session?.exitIp || '',
            exitCountryCode: exitNetwork?.countryCode || session?.countryCode || '',
            viaProxy: Boolean(proxy),
          },
        });
      } catch (error) {
        return this.#json(res, 500, { ok: false, msg: error.message });
      }
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
