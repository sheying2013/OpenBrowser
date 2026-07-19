const net = require('net');
const tls = require('tls');

function decode(value) {
  try { return decodeURIComponent(value); } catch (_) { return value; }
}

function parseProxy(value) {
  const raw = String(value || '').trim();
  if (!raw || /^(direct|offline|none)$/i.test(raw)) return null;
  let protocol = 'http'; let host = ''; let port = 0; let username = ''; let password = '';
  const legacyScheme = raw.match(/^(https?|socks5):\/\/([^:@/]+):(\d{1,5}):([^:]+):(.+)$/i);
  if (legacyScheme) {
    protocol = legacyScheme[1].toLowerCase(); host = legacyScheme[2]; port = Number(legacyScheme[3]); username = legacyScheme[4]; password = legacyScheme[5];
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    let parsed;
    try { parsed = new URL(raw); } catch (_) { throw new Error('Invalid proxy format'); }
    protocol = parsed.protocol.replace(':', '').toLowerCase();
    host = parsed.hostname; port = Number(parsed.port || (protocol === 'https' ? 443 : 0));
    username = decode(parsed.username); password = decode(parsed.password);
  } else {
    const parts = raw.split(':');
    if (parts.length === 2) [host, port] = [parts[0], Number(parts[1])];
    else if (parts.length >= 4) { protocol = 'socks5'; host = parts[0]; port = Number(parts[1]); username = parts[2]; password = parts.slice(3).join(':'); }
    else throw new Error('Invalid proxy format; use host:port or protocol://username:password@host:port');
  }
  if (!['http', 'https', 'socks4', 'socks5'].includes(protocol)) throw new Error('Unsupported proxy protocol');
  if (!/^[a-zA-Z0-9._-]+$/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid proxy host or port');
  if ((username && !password) || (!username && password)) throw new Error('Proxy username and password must both be provided');
  if (username && protocol === 'socks4') throw new Error('Authenticated SOCKS proxies must use SOCKS5');
  return { raw, protocol, host, port, username, password, authenticated: Boolean(username), chromeUrl: protocol + '://' + host + ':' + port };
}

function displayProxy(value) {
  try {
    const config = parseProxy(value);
    if (!config) return 'Direct';
    return config.protocol.toUpperCase() + ' · ' + config.host + ':' + config.port + (config.authenticated ? ' · Auth' : '');
  } catch (_) { return 'Invalid proxy'; }
}


/**
 * Local TLS profile descriptors for future dialer integration.
 * These describe ClientHello-oriented preferences only; Node's tls.connect
 * still performs the handshake. A dedicated dialer can consume the same shape.
 */
const TLS_PROFILE_PRESETS = {
  chrome: {
    id: 'chrome',
    alpn: ['h2', 'http/1.1'],
    minVersion: 'TLSv1.2',
    maxVersion: 'TLSv1.3',
    // Cipher order approximates modern Chrome; exact GREASE/extension order needs a custom dialer.
    ciphers: [
      'TLS_AES_128_GCM_SHA256',
      'TLS_AES_256_GCM_SHA384',
      'TLS_CHACHA20_POLY1305_SHA256',
      'ECDHE-ECDSA-AES128-GCM-SHA256',
      'ECDHE-RSA-AES128-GCM-SHA256',
      'ECDHE-ECDSA-AES256-GCM-SHA384',
      'ECDHE-RSA-AES256-GCM-SHA384',
      'ECDHE-ECDSA-CHACHA20-POLY1305',
      'ECDHE-RSA-CHACHA20-POLY1305',
      'ECDHE-RSA-AES128-SHA',
      'ECDHE-RSA-AES256-SHA',
      'AES128-GCM-SHA256',
      'AES256-GCM-SHA384',
      'AES128-SHA',
      'AES256-SHA',
    ].join(':'),
    ecdhCurve: 'X25519:P-256:P-384',
    permuteExtensions: true,
    grease: true,
  },
  chrome_legacy: {
    id: 'chrome_legacy',
    alpn: ['h2', 'http/1.1'],
    minVersion: 'TLSv1.2',
    maxVersion: 'TLSv1.3',
    ciphers: [
      'TLS_AES_128_GCM_SHA256',
      'TLS_AES_256_GCM_SHA384',
      'TLS_CHACHA20_POLY1305_SHA256',
      'ECDHE-ECDSA-AES128-GCM-SHA256',
      'ECDHE-RSA-AES128-GCM-SHA256',
      'ECDHE-ECDSA-AES256-GCM-SHA384',
      'ECDHE-RSA-AES256-GCM-SHA384',
      'ECDHE-ECDSA-CHACHA20-POLY1305',
      'ECDHE-RSA-CHACHA20-POLY1305',
      'ECDHE-RSA-AES128-SHA',
      'ECDHE-RSA-AES256-SHA',
      'AES128-GCM-SHA256',
      'AES256-GCM-SHA384',
      'AES128-SHA',
      'AES256-SHA',
    ].join(':'),
    ecdhCurve: 'X25519:P-256:P-384',
    permuteExtensions: false,
    grease: false,
  },
  node: {
    id: 'node',
    alpn: ['http/1.1', 'h2'],
    minVersion: 'TLSv1.2',
    maxVersion: 'TLSv1.3',
    ciphers: null,
    ecdhCurve: null,
    permuteExtensions: false,
    grease: false,
  },
};

function resolveTlsProfile(input = {}) {
  if (!input || input === false || input === 'off' || input === 'disabled') {
    return { ...TLS_PROFILE_PRESETS.node, id: 'off', enabled: false };
  }
  const raw = typeof input === 'string' ? { id: input } : (typeof input === 'object' ? input : {});
  const major = Number(raw.chromeMajor || raw.major || 0) || 0;
  let id = String(raw.id || raw.profile || raw.name || '').trim().toLowerCase();
  if (!id || id === 'auto') {
    id = major && major < 106 ? 'chrome_legacy' : 'chrome';
  }
  if (id === 'chrome' && major && major < 106) id = 'chrome_legacy';
  const base = TLS_PROFILE_PRESETS[id] || TLS_PROFILE_PRESETS.chrome;
  const profile = {
    ...base,
    id: base.id,
    enabled: raw.enabled !== false,
    chromeMajor: major || null,
    servername: raw.servername ? String(raw.servername).slice(0, 253) : null,
    alpn: Array.isArray(raw.alpn) && raw.alpn.length
      ? raw.alpn.map((v) => String(v)).filter(Boolean).slice(0, 8)
      : base.alpn.slice(),
    minVersion: raw.minVersion || base.minVersion,
    maxVersion: raw.maxVersion || base.maxVersion,
    ciphers: raw.ciphers != null ? String(raw.ciphers) : base.ciphers,
    ecdhCurve: raw.ecdhCurve != null ? String(raw.ecdhCurve) : base.ecdhCurve,
    permuteExtensions: raw.permuteExtensions != null ? Boolean(raw.permuteExtensions) : base.permuteExtensions,
    grease: raw.grease != null ? Boolean(raw.grease) : base.grease,
  };
  return profile;
}

/** Options for Node tls.connect that we can apply today without a custom dialer. */
function tlsConnectOptionsFromProfile(profile, { socket, servername, rejectUnauthorized = true } = {}) {
  const resolved = resolveTlsProfile(profile || 'node');
  const options = {
    rejectUnauthorized: rejectUnauthorized !== false,
  };
  if (socket) options.socket = socket;
  const sn = servername || resolved.servername;
  if (sn) options.servername = sn;
  if (!resolved.enabled || resolved.id === 'off' || resolved.id === 'node') {
    return options;
  }
  if (resolved.minVersion) options.minVersion = resolved.minVersion;
  if (resolved.maxVersion) options.maxVersion = resolved.maxVersion;
  if (resolved.ciphers) options.ciphers = resolved.ciphers;
  if (resolved.ecdhCurve) options.ecdhCurve = resolved.ecdhCurve;
  if (resolved.alpn && resolved.alpn.length) options.ALPNProtocols = resolved.alpn.slice();
  return options;
}


class BufferedReader {
  constructor(socket) {
    this.socket = socket; this.buffer = Buffer.alloc(0); this.waiters = []; this.failure = null;
    this.onData = (chunk) => { this.buffer = Buffer.concat([this.buffer, chunk]); this.pump(); };
    this.onError = (error) => this.fail(error);
    this.onClose = () => this.fail(new Error('Socket closed during handshake'));
    socket.on('data', this.onData); socket.on('error', this.onError); socket.on('close', this.onClose);
  }
  read(size, timeout = 15000) { return this.wait({ type: 'size', size, timeout }); }
  readUntil(marker, max = 65536, timeout = 15000) { return this.wait({ type: 'marker', marker: Buffer.from(marker), max, timeout }); }
  wait(options) {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const waiter = { ...options, resolve, reject };
      waiter.timer = setTimeout(() => { this.waiters = this.waiters.filter((item) => item !== waiter); reject(new Error('Proxy handshake timed out')); }, options.timeout);
      this.waiters.push(waiter); this.pump();
    });
  }
  pump() {
    const waiter = this.waiters[0]; if (!waiter) return;
    let end = -1;
    if (waiter.type === 'size' && this.buffer.length >= waiter.size) end = waiter.size;
    if (waiter.type === 'marker') {
      const index = this.buffer.indexOf(waiter.marker);
      if (index >= 0) end = index + waiter.marker.length;
      else if (this.buffer.length > waiter.max) return this.fail(new Error('Proxy response header was too large'));
    }
    if (end < 0) return;
    this.waiters.shift(); clearTimeout(waiter.timer);
    const value = this.buffer.subarray(0, end); this.buffer = this.buffer.subarray(end); waiter.resolve(value);
  }
  fail(error) {
    if (this.failure) return; this.failure = error;
    for (const waiter of this.waiters.splice(0)) { clearTimeout(waiter.timer); waiter.reject(error); }
  }
  release() {
    this.socket.off('data', this.onData); this.socket.off('error', this.onError); this.socket.off('close', this.onClose);
    const value = this.buffer; this.buffer = Buffer.alloc(0); return value;
  }
}

function connectSocket(host, port, timeout = 8000, signal = null) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Proxy bridge closed'));
    const socket = net.connect({ host, port });
    const onError = (error) => { socket.off('connect', onConnect); reject(error); };
    const onConnect = () => { socket.off('error', onError); socket.setTimeout(0); socket.setKeepAlive(true, 10000); resolve(socket); };
    socket.setTimeout(timeout, () => socket.destroy(new Error('Proxy connection timed out')));
    signal?.addEventListener('abort', () => socket.destroy(new Error('Proxy bridge closed')), { once: true });
    socket.once('error', onError); socket.once('connect', onConnect);
  });
}

function makeNotifier(onStatus) {
  let last = '';
  return (code, message) => {
    const key = code + ':' + message; if (last === key) return; last = key;
    try { onStatus({ code, message }); } catch (_) {}
  };
}

async function readSocksAddress(reader, atyp) {
  if (atyp === 1) return reader.read(4);
  if (atyp === 4) return reader.read(16);
  if (atyp === 3) { const size = await reader.read(1); return Buffer.concat([size, await reader.read(size[0])]); }
  throw new Error('Unsupported SOCKS address type');
}

function encodeSocksAddress(host) {
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return Buffer.from([1, ...host.split('.').map(Number)]);
  const value = Buffer.from(host, 'utf8'); if (!value.length || value.length > 255) throw new Error('SOCKS5 target hostname is invalid');
  return Buffer.concat([Buffer.from([3, value.length]), value]);
}

async function connectSocksTargetOnce(config, host, port, signal = null) {
  let upstream;
  try {
    upstream = await connectSocket(config.host, config.port, 8000, signal); upstream.on('error', () => {});
    const reader = new BufferedReader(upstream); const timeout = 8000;
    upstream.write(config.authenticated ? Buffer.from([5, 2, 0, 2]) : Buffer.from([5, 1, 0]));
    const method = await reader.read(2, timeout); if (method[0] !== 5 || method[1] === 255) throw new Error('SOCKS5 proxy rejected available authentication methods');
    if (method[1] === 2) {
      const user = Buffer.from(config.username, 'utf8'); const password = Buffer.from(config.password, 'utf8');
      if (!user.length || user.length > 255 || !password.length || password.length > 255) throw new Error('SOCKS5 username or password length is invalid');
      upstream.write(Buffer.concat([Buffer.from([1, user.length]), user, Buffer.from([password.length]), password]));
      const auth = await reader.read(2, timeout); if (auth[1] !== 0) throw new Error('SOCKS5 authentication failed');
    } else if (method[1] !== 0) throw new Error('SOCKS5 proxy selected an unsupported authentication method');
    upstream.write(Buffer.concat([Buffer.from([5, 1, 0]), encodeSocksAddress(host), Buffer.from([port >> 8, port & 255])]));
    const response = await reader.read(4, timeout); await readSocksAddress(reader, response[3]); await reader.read(2, timeout);
    if (response[1] !== 0) throw new Error('SOCKS5 upstream connection failed with code ' + response[1]);
    const remainder = reader.release(); return { upstream, remainder };
  } catch (error) {
    upstream?.destroy();
    throw error;
  }
}

function retryableSocksError(error) {
  const message = String(error?.message || '');
  return !/authentication failed|rejected available authentication|unsupported authentication|username or password length|target hostname is invalid|upstream connection failed with code/i.test(message);
}

async function connectSocksTarget(config, host, port, attempts = 3, signal = null) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (signal?.aborted) throw new Error('Proxy bridge closed');
    try { return await connectSocksTargetOnce(config, host, port, signal); }
    catch (error) {
      lastError = error;
      if (signal?.aborted || attempt >= attempts || !retryableSocksError(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 180 * attempt));
    }
  }
  throw lastError || new Error('SOCKS5 connection failed');
}

function concurrentConnector(callback, maxConcurrent = 4, spacing = 60) {
  const queue = []; let active = 0; let nextAt = 0; let timer = null;
  const pump = () => {
    if (timer) return;
    while (active < maxConcurrent && queue.length) {
      const wait = Math.max(0, nextAt - Date.now());
      if (wait) { timer = setTimeout(() => { timer = null; pump(); }, wait); return; }
      const item = queue.shift(); active += 1; nextAt = Date.now() + spacing;
      Promise.resolve().then(() => callback(...item.args)).then(item.resolve, item.reject).finally(() => { active -= 1; pump(); });
    }
  };
  return (...args) => new Promise((resolve, reject) => { queue.push({ args, resolve, reject }); pump(); });
}

function parseHttpTarget(header) {
  const first = header.split('\r\n', 1)[0]; const parts = first.split(/\s+/); const method = String(parts[0] || '').toUpperCase(); const target = String(parts[1] || '');
  if (method === 'CONNECT') {
    const separator = target.lastIndexOf(':'); if (separator < 1) throw new Error('Invalid HTTP CONNECT target');
    return { method, host: target.slice(0, separator).replace(/^\[|\]$/g, ''), port: Number(target.slice(separator + 1)), header };
  }
  const url = new URL(target); const path = (url.pathname || '/') + url.search;
  const lines = header.split('\r\n'); lines[0] = method + ' ' + path + ' ' + (parts[2] || 'HTTP/1.1');
  return { method, host: url.hostname, port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)), header: lines.filter((line) => !/^proxy-authorization:/i.test(line) && !/^proxy-connection:/i.test(line)).join('\r\n') };
}

async function startHttpToSocks5Bridge(config, onStatus) {
  const sockets = new Set(); const notify = makeNotifier(onStatus); const controller = new AbortController();
  // Keep authentication handshakes paced for residential proxies, without
  // making a modern Chrome page wait almost a second for every connection.
  const connectTarget = concurrentConnector((host, port) => connectSocksTarget(config, host, port, 3, controller.signal), 4, 60);
  const server = net.createServer((client) => {
    sockets.add(client); client.setNoDelay(true); client.on('error', () => {}); client.once('close', () => sockets.delete(client));
    let pending = Buffer.alloc(0);
    const receiveHeader = (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      if (pending.length > 65536) { client.end('HTTP/1.1 431 Request Header Fields Too Large\r\nConnection: close\r\n\r\n'); return; }
      const marker = pending.indexOf('\r\n\r\n'); if (marker < 0) return;
      client.off('data', receiveHeader); client.pause();
      const header = pending.subarray(0, marker + 4).toString('latin1'); const body = pending.subarray(marker + 4);
      let target = null;
      (async () => {
        target = parseHttpTarget(header);
        if (process.env.OPENBROWSER_PROXY_DIAGNOSTICS === '1') notify('REQUEST', target.host + ':' + target.port);
        if (/^(mtalk\.google\.com|android\.clients\.google\.com|connectivitycheck\.gstatic\.com|update\.googleapis\.com)$/i.test(target.host)) { client.end(target.method === 'CONNECT' ? 'HTTP/1.1 502 Background Request Blocked\r\nConnection: close\r\n\r\n' : 'HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n'); return; }
        const connected = await connectTarget(target.host, target.port); const upstream = connected.upstream;
        if (process.env.OPENBROWSER_PROXY_DIAGNOSTICS === '1') notify('CONNECTED', target.host + ':' + target.port);
        if (client.destroyed) { upstream.destroy(); return; }
        sockets.add(upstream); upstream.once('close', () => sockets.delete(upstream)); upstream.on('error', () => client.destroy()); client.on('error', () => upstream.destroy());
        if (target.method === 'CONNECT') client.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: OpenBrowser\r\n\r\n');
        else upstream.write(target.header, 'latin1');
        if (connected.remainder.length) client.write(connected.remainder); if (body.length) upstream.write(body);
        client.pipe(upstream); upstream.pipe(client); client.resume();
      })().catch((error) => {
        if (controller.signal.aborted) { client.destroy(); return; }
        notify(error.message.includes('authentication') ? 'AUTH_FAILED' : 'UPSTREAM_CONNECT_FAILED', (target?.host ? target.host + ':' + target.port + ' ? ' : '') + error.message);
        if (!client.destroyed) client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
      });
    };
    client.on('data', receiveHeader);
  });
  await listen(server, notify);
  return bridgeResult(server, sockets, 'http', () => controller.abort());
}

async function startSocks5Bridge(config, onStatus) {
  const sockets = new Set(); const notify = makeNotifier(onStatus);
  const server = net.createServer((client) => {
    sockets.add(client); client.setNoDelay(true); client.on('error', () => {}); client.once('close', () => sockets.delete(client));
    (async () => {
      const local = new BufferedReader(client);
      const greeting = await local.read(2); if (greeting[0] !== 5) throw new Error('Invalid local SOCKS5 greeting');
      await local.read(greeting[1]); client.write(Buffer.from([5, 0]));
      const requestHead = await local.read(4); if (requestHead[0] !== 5 || requestHead[1] !== 1) throw new Error('Only SOCKS5 CONNECT is supported');
      const requestAddress = await readSocksAddress(local, requestHead[3]); const requestPort = await local.read(2);
      const upstream = await connectSocket(config.host, config.port); sockets.add(upstream);
      upstream.on('error', () => { if (!client.destroyed) client.destroy(); }); client.on('error', () => upstream.destroy()); upstream.once('close', () => sockets.delete(upstream));
      const remote = new BufferedReader(upstream);
      upstream.write(config.authenticated ? Buffer.from([5, 2, 0, 2]) : Buffer.from([5, 1, 0]));
      const method = await remote.read(2); if (method[0] !== 5 || method[1] === 255) throw new Error('SOCKS5 proxy rejected available authentication methods');
      if (method[1] === 2) {
        const user = Buffer.from(config.username, 'utf8'); const password = Buffer.from(config.password, 'utf8');
        if (!user.length || user.length > 255 || !password.length || password.length > 255) throw new Error('SOCKS5 username or password length is invalid');
        upstream.write(Buffer.concat([Buffer.from([1, user.length]), user, Buffer.from([password.length]), password]));
        const auth = await remote.read(2);
        if (auth[1] !== 0) { notify('AUTH_FAILED', 'SOCKS5 username or password was rejected'); throw new Error('SOCKS5 authentication failed'); }
      } else if (method[1] !== 0) throw new Error('SOCKS5 proxy selected an unsupported authentication method');
      upstream.write(Buffer.concat([requestHead, requestAddress, requestPort]));
      const responseHead = await remote.read(4); const responseAddress = await readSocksAddress(remote, responseHead[3]); const responsePort = await remote.read(2);
      client.write(Buffer.concat([responseHead, responseAddress, responsePort]));
      if (responseHead[1] !== 0) { notify('TUNNEL_FAILED', 'SOCKS5 tunnel failed with code ' + responseHead[1]); throw new Error('SOCKS5 upstream connection failed'); }
      const localRemainder = local.release(); const remoteRemainder = remote.release();
      if (localRemainder.length) upstream.write(localRemainder); if (remoteRemainder.length) client.write(remoteRemainder);
      client.pipe(upstream); upstream.pipe(client);
    })().catch((error) => {
      notify(error.message.includes('authentication') ? 'AUTH_FAILED' : 'UPSTREAM_CONNECT_FAILED', error.message);
      if (!client.destroyed) client.end(Buffer.from([5, 1, 0, 1, 0, 0, 0, 0, 0, 0]));
    });
  });
  await listen(server, notify);
  return bridgeResult(server, sockets, 'socks5');
}

function authorization(config) {
  return 'Basic ' + Buffer.from(config.username + ':' + config.password, 'utf8').toString('base64');
}

function forwardedHeader(header, config) {
  const lines = header.split('\r\n'); const first = lines.shift();
  const kept = lines.filter((line) => line && !/^proxy-authorization:/i.test(line) && !/^proxy-connection:/i.test(line));
  if (config.authenticated) kept.push('Proxy-Authorization: ' + authorization(config));
  return [first, ...kept, 'Proxy-Connection: Keep-Alive', '', ''].join('\r\n');
}

function connectHttpUpstream(config, onConnect) {
  if (config.protocol === 'https') {
    const tlsProfile = resolveTlsProfile(config.tlsProfile || 'auto');
    const opts = tlsConnectOptionsFromProfile(tlsProfile, { servername: config.host, rejectUnauthorized: true });
    opts.host = config.host;
    opts.port = config.port;
    return tls.connect(opts, onConnect);
  }
  return net.connect({ host: config.host, port: config.port }, onConnect);
}

async function startHttpBridge(config, onStatus) {
  const sockets = new Set(); const notify = makeNotifier(onStatus);
  const server = net.createServer((client) => {
    sockets.add(client); client.setNoDelay(true); client.once('close', () => sockets.delete(client));
    let pending = Buffer.alloc(0);
    const receiveHeader = (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      if (pending.length > 65536) { client.end('HTTP/1.1 431 Request Header Fields Too Large\r\nConnection: close\r\n\r\n'); return; }
      const marker = pending.indexOf('\r\n\r\n'); if (marker < 0) return;
      client.removeListener('data', receiveHeader); client.pause();
      const header = pending.subarray(0, marker + 4).toString('latin1'); const remainder = pending.subarray(marker + 4);
      const isConnect = /^CONNECT\s+/i.test(header.split('\r\n', 1)[0]); let upstream;
      const fail = (message) => { notify('UPSTREAM_CONNECT_FAILED', message); if (!client.destroyed) client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'); };
      try {
        upstream = connectHttpUpstream(config, () => {
          upstream.write(forwardedHeader(header, config), 'latin1');
          if (!isConnect) { if (remainder.length) upstream.write(remainder); client.pipe(upstream); upstream.pipe(client); client.resume(); return; }
          let response = Buffer.alloc(0);
          const receiveResponse = (data) => {
            response = Buffer.concat([response, data]); if (response.length > 65536) { upstream.destroy(); fail('Proxy response header was too large'); return; }
            const responseMarker = response.indexOf('\r\n\r\n'); if (responseMarker < 0) return;
            upstream.removeListener('data', receiveResponse);
            const responseHeader = response.subarray(0, responseMarker + 4); const responseRemainder = response.subarray(responseMarker + 4);
            const match = responseHeader.toString('latin1').split('\r\n', 1)[0].match(/\s(\d{3})(?:\s|$)/); const status = Number(match?.[1] || 0);
            if (status !== 200) {
              notify(status === 407 ? 'AUTH_FAILED' : 'TUNNEL_FAILED', status === 407 ? 'Proxy username or password was rejected' : 'Proxy tunnel failed with HTTP ' + status);
              client.end(responseHeader); upstream.end(); return;
            }
            // Chrome is happier with a clean CONNECT reply than whatever the upstream proxy returned.
            client.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: OpenBrowser\r\n\r\n');
            if (responseRemainder.length) client.write(responseRemainder);
            if (remainder.length) upstream.write(remainder); client.pipe(upstream); upstream.pipe(client); client.resume();
          };
          upstream.on('data', receiveResponse);
        });
      } catch (error) { fail(error.message); return; }
      sockets.add(upstream); upstream.once('close', () => sockets.delete(upstream));
      upstream.once('error', (error) => { if (!client.destroyed) fail(error.message); client.destroy(); }); client.once('error', () => upstream.destroy());
    };
    client.on('data', receiveHeader); client.on('error', () => {});
  });
  await listen(server, notify);
  return bridgeResult(server, sockets, 'http');
}

function listen(server, notify) {
  server.on('error', (error) => notify('LOCAL_PROXY_FAILED', error.message));
  return new Promise((resolve, reject) => {
    const onError = (error) => { server.off('listening', onListen); reject(error); };
    const onListen = () => { server.off('error', onError); resolve(); };
    server.once('error', onError); server.once('listening', onListen); server.listen(0, '127.0.0.1');
  });
}

function bridgeResult(server, sockets, protocol, onClose = () => {}) {
  const address = server.address();
  return {
    protocol, port: address.port, url: protocol + '://127.0.0.1:' + address.port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      onClose();
      await new Promise((resolve) => server.close(() => resolve()));
    }
  };
}

async function startAuthenticatedProxy(config, onStatus = () => {}) {
  if (!config) throw new Error('Proxy configuration is required');
  if (config.protocol === 'socks5') return startHttpToSocks5Bridge(config, onStatus);
  if (['http', 'https'].includes(config.protocol)) return startHttpBridge(config, onStatus);
  throw new Error('SOCKS4 bridge is not supported');
}

async function connectBridge(bridge, hostname, port) {
  const socket = await connectSocket('127.0.0.1', bridge.port); const reader = new BufferedReader(socket);
  if (bridge.protocol === 'http') {
    socket.write('CONNECT ' + hostname + ':' + port + ' HTTP/1.1\r\nHost: ' + hostname + ':' + port + '\r\nConnection: close\r\n\r\n');
    const header = await reader.readUntil('\r\n\r\n'); const status = Number(header.toString('latin1').split('\r\n', 1)[0].match(/\s(\d{3})(?:\s|$)/)?.[1] || 0);
    if (status !== 200) throw new Error('Proxy test tunnel failed with HTTP ' + status);
  } else {
    socket.write(Buffer.from([5, 1, 0])); const greeting = await reader.read(2); if (greeting[1] !== 0) throw new Error('Local SOCKS5 bridge rejected no-auth mode');
    const host = Buffer.from(hostname, 'utf8'); socket.write(Buffer.concat([Buffer.from([5, 1, 0, 3, host.length]), host, Buffer.from([port >> 8, port & 255])]));
    const reply = await reader.read(4); await readSocksAddress(reader, reply[3]); await reader.read(2); if (reply[1] !== 0) throw new Error('SOCKS5 proxy test tunnel failed with code ' + reply[1]);
  }
  const remainder = reader.release(); if (remainder.length) throw new Error('Unexpected bytes before TLS handshake');
  return socket;
}

function decodeChunked(buffer) {
  const chunks = []; let offset = 0;
  while (offset < buffer.length) {
    const line = buffer.indexOf('\r\n', offset); if (line < 0) throw new Error('Invalid chunked response');
    const size = Number.parseInt(buffer.subarray(offset, line).toString('ascii').split(';')[0], 16); if (!Number.isFinite(size)) throw new Error('Invalid chunk size');
    offset = line + 2; if (size === 0) break; chunks.push(buffer.subarray(offset, offset + size)); offset += size + 2;
  }
  return Buffer.concat(chunks);
}

async function requestProxyHttp(config, hostname, pathname) {
  const bridge = await startAuthenticatedProxy(config); let socket;
  try {
    socket = bridge.protocol === 'http' ? await connectSocket('127.0.0.1', bridge.port) : await connectBridge(bridge, hostname, 80);
    const target = bridge.protocol === 'http' ? 'http://' + hostname + pathname : pathname;
    socket.write('GET ' + target + ' HTTP/1.1\r\nHost: ' + hostname + '\r\nAccept: application/json\r\nAccept-Encoding: identity\r\nConnection: close\r\nUser-Agent: OpenBrowser/2.0\r\n\r\n');
    const chunks = await new Promise((resolve, reject) => {
      const values = []; const timer = setTimeout(() => { socket.destroy(); reject(new Error('Proxy exit lookup timed out')); }, 15000);
      socket.on('data', (chunk) => values.push(chunk));
      socket.once('end', () => { clearTimeout(timer); resolve(values); });
      socket.once('error', (error) => { clearTimeout(timer); reject(error); });
    });
    const response = Buffer.concat(chunks); const marker = response.indexOf('\r\n\r\n');
    if (marker < 0) throw new Error('Invalid proxy exit lookup response');
    const header = response.subarray(0, marker).toString('latin1');
    const status = Number(header.split('\r\n', 1)[0].match(/\s(\d{3})(?:\s|$)/)?.[1] || 0);
    let body = response.subarray(marker + 4); if (/transfer-encoding:\s*chunked/i.test(header)) body = decodeChunked(body);
    return { status, body };
  } finally {
    socket?.destroy(); await bridge.close().catch(() => {});
  }
}

function normalizeIpApiResult(value) {
  const ip = String(value.query || '');
  const countryCode = String(value.countryCode || '').toUpperCase();
  if (value.status !== 'success' || !ip || !/^[A-Z]{2}$/.test(countryCode)) {
    throw new Error(String(value.message || 'Proxy exit lookup response was incomplete'));
  }
  return {
    ip,
    country: String(value.country || ''),
    countryCode,
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
  };
}

function classifyProxyError(error) {
  const msg = String(error && error.message ? error.message : error || '');
  if (/authentication failed|username or password|407|rejected available authentication/i.test(msg)) return 'auth';
  if (/timed?\s*out|timeout/i.test(msg)) return 'timeout';
  if (/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|socket hang up|connect/i.test(msg)) return 'unreachable';
  if (/Unsupported proxy protocol|Invalid proxy|SOCKS|protocol/i.test(msg)) return 'protocol';
  return 'unknown';
}

function networkTypeFromLookup(result = {}) {
  if (result.mobile) return 'mobile';
  if (result.hosting) return 'hosting';
  if (result.proxy) return 'proxy';
  return 'broadband';
}

async function fetchUrlText(url, { timeout = 15000, method = 'GET' } = {}) {
  const target = String(url || '').trim();
  if (!/^https?:\/\//i.test(target)) throw new Error('URL 必须以 http:// 或 https:// 开头');
  const https = require('https');
  const http = require('http');
  const lib = target.startsWith('https') ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(target, {
      method,
      timeout,
      headers: {
        Accept: 'text/plain, application/json, */*',
        'User-Agent': 'OpenBrowser/2.0',
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if ((res.statusCode || 0) >= 400) {
          reject(new Error('HTTP ' + res.statusCode + ': ' + body.slice(0, 160)));
          return;
        }
        resolve({ status: res.statusCode || 0, body, headers: res.headers || {} });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.end();
  });
}

function extractProxyStrings(text) {
  const raw = String(text || '').trim();
  if (!raw) return [];
  const out = [];
  const push = (value) => {
    const s = String(value || '').trim();
    if (s && !out.includes(s)) out.push(s);
  };
  try {
    const json = JSON.parse(raw);
    const walk = (node, depth = 0) => {
      if (depth > 6 || node == null) return;
      if (typeof node === 'string') {
        push(node);
        return;
      }
      if (Array.isArray(node)) {
        for (const item of node.slice(0, 50)) walk(item, depth + 1);
        return;
      }
      if (typeof node === 'object') {
        const host = node.host || node.ip || node.server || node.hostname;
        const port = node.port;
        const user = node.username || node.user || node.login;
        const pass = node.password || node.pass || node.pwd;
        const protocol = String(node.protocol || node.type || node.schema || 'http').toLowerCase().replace('://', '');
        if (host && port) {
          if (user && pass) push(`${protocol}://${user}:${pass}@${host}:${port}`);
          else push(`${protocol}://${host}:${port}`);
        }
        for (const key of ['proxy', 'proxies', 'data', 'result', 'list', 'items', 'url', 'raw', 'line', 'value', 'content']) {
          if (key in node) walk(node[key], depth + 1);
        }
      }
    };
    walk(json);
  } catch (_) {
    // plain text body
  }
  for (const line of raw.split(/[\r\n,;]+/)) {
    const s = line.trim();
    if (!s || s.startsWith('#') || s.length > 400) continue;
    if (/^(https?|socks5):\/\//i.test(s) || /^[\w.-]+:\d{2,5}(?::[^\s]+)?$/.test(s)) push(s);
  }
  const re = /(?:(?:https?|socks5):\/\/)?(?:[^\s@/:]+:[^\s@/]+@)?[\w.-]+:\d{2,5}/gi;
  let m;
  while ((m = re.exec(raw)) && out.length < 30) push(m[0]);
  return out;
}

async function extractProxyFromApi(url) {
  const { body } = await fetchUrlText(url, { timeout: 20000 });
  const candidates = extractProxyStrings(body);
  const errors = [];
  for (const candidate of candidates.slice(0, 20)) {
    try {
      const config = parseProxy(candidate);
      if (config) return config;
    } catch (error) {
      errors.push(String(error.message || error));
    }
  }
  throw new Error(errors[0] ? ('API 响应无法解析为代理：' + errors[0]) : 'API 响应中未找到代理地址');
}

async function invokeProxyRefresh(url) {
  const started = Date.now();
  const result = await fetchUrlText(url, { timeout: 20000, method: 'GET' });
  return {
    ok: true,
    status: result.status,
    latencyMs: Date.now() - started,
    refreshedAt: new Date().toISOString(),
    preview: String(result.body || '').slice(0, 200),
  };
}

async function lookupProxyCountry(config) {
  const fields = 'status,message,country,countryCode,regionName,city,zip,timezone,lat,lon,isp,org,as,asname,mobile,proxy,hosting,query';
  const started = Date.now();
  try {
    const response = await requestProxyHttp(config, 'ip-api.com', '/json/?fields=' + fields);
    if (response.status !== 200) throw new Error('Proxy exit lookup returned HTTP ' + response.status);
    const value = JSON.parse(response.body.toString('utf8'));
    const result = normalizeIpApiResult(value);
    const latencyMs = Date.now() - started;
    return {
      ...result,
      latencyMs,
      networkType: networkTypeFromLookup(result),
    };
  } catch (error) {
    const err = new Error(error.message || String(error));
    err.errorClass = classifyProxyError(error);
    err.latencyMs = Date.now() - started;
    throw err;
  }
}

function normalizeIpWhoResult(value) {
  const ip = String(value.ip || value.query || '');
  const countryCode = String(value.country_code || value.countryCode || '').toUpperCase();
  if (value.success === false || !ip || !/^[A-Z]{2}$/.test(countryCode)) {
    throw new Error(String(value.message || 'Direct exit lookup response was incomplete'));
  }
  const tz = value.timezone && typeof value.timezone === 'object'
    ? String(value.timezone.id || value.timezone.name || '')
    : String(value.timezone || '');
  return {
    ip,
    country: String(value.country || ''),
    countryCode,
    region: String(value.region || value.regionName || ''),
    city: String(value.city || ''),
    zip: String(value.postal || value.zip || ''),
    timezone: tz,
    latitude: Number.isFinite(Number(value.latitude ?? value.lat)) ? Number(value.latitude ?? value.lat) : null,
    longitude: Number.isFinite(Number(value.longitude ?? value.lon)) ? Number(value.longitude ?? value.lon) : null,
    isp: String(value.connection?.isp || value.isp || ''),
    organization: String(value.connection?.org || value.org || ''),
    asn: String(value.connection?.asn || value.asn || value.as || '').toString().split(/\s+/, 1)[0],
    asName: String(value.connection?.org || value.asname || ''),
    mobile: Boolean(value.connection?.mobile || value.mobile),
    proxy: Boolean(value.security?.proxy || value.proxy),
    hosting: Boolean(value.connection?.hosting || value.hosting),
    checkedAt: new Date().toISOString(),
  };
}

/** Direct (no proxy) exit lookup for language-from-IP on local direct mode. */
async function lookupDirectCountry() {
  const fields = 'status,message,country,countryCode,regionName,city,zip,timezone,lat,lon,isp,org,as,asname,mobile,proxy,hosting,query';
  // Free ip-api.com only allows HTTP; HTTPS returns 403. Prefer HTTP, then other public endpoints.
  const endpoints = [
    { url: `http://ip-api.com/json/?fields=${fields}`, kind: 'ip-api' },
    { url: 'https://ipwho.is/', kind: 'ipwho' },
    { url: 'http://ipwho.is/', kind: 'ipwho' },
  ];
  const errors = [];
  for (const endpoint of endpoints) {
    try {
      const { status, body } = await fetchUrlText(endpoint.url, { timeout: 12000 });
      if (status !== 200) throw new Error('HTTP ' + status);
      const value = JSON.parse(body);
      if (endpoint.kind === 'ip-api') return normalizeIpApiResult(value);
      return normalizeIpWhoResult(value);
    } catch (error) {
      errors.push(String(error.message || error));
    }
  }
  throw new Error(errors[0] ? ('本地出口查询失败：' + errors[0]) : '本地出口查询失败');
}

async function probeProxyTunnel(config, hostname = 'www.google.com', port = 443) {
  const bridge = await startAuthenticatedProxy(config); let socket;
  try {
    socket = await connectBridge(bridge, hostname, port);
    return { hostname, port };
  } finally {
    socket?.destroy(); await bridge.close().catch(() => {});
  }
}

async function probeProxyHttps(config, hostname = 'www.google.com', pathname = '/generate_204', options = {}) {
  const bridge = await startAuthenticatedProxy(config); let socket; let secure;
  try {
    socket = await connectBridge(bridge, hostname, 443);
    const tlsProfile = resolveTlsProfile(options.tlsProfile || config.tlsProfile || 'auto');
    secure = tls.connect(tlsConnectOptionsFromProfile(tlsProfile, { socket, servername: hostname, rejectUnauthorized: true }));
    await new Promise((resolve, reject) => { const timer = setTimeout(() => { secure.destroy(); reject(new Error('Google HTTPS handshake timed out')); }, 15000); secure.once('secureConnect', () => { clearTimeout(timer); resolve(); }); secure.once('error', (error) => { clearTimeout(timer); reject(error); }); });
    const reader = new BufferedReader(secure);
    secure.write('HEAD ' + pathname + ' HTTP/1.1\r\nHost: ' + hostname + '\r\nConnection: close\r\nUser-Agent: OpenBrowser/2.0\r\n\r\n');
    const header = (await reader.readUntil('\r\n\r\n', 65536, 15000)).toString('latin1'); reader.release();
    const status = Number(header.split('\r\n', 1)[0].match(/\s(\d{3})(?:\s|$)/)?.[1] || 0);
    if (status < 200 || status >= 400) throw new Error('Google HTTPS probe returned HTTP ' + status);
    return { hostname, status };
  } finally {
    secure?.destroy(); socket?.destroy(); await bridge.close().catch(() => {});
  }
}

module.exports = {
  parseProxy,
  displayProxy,
  startAuthenticatedProxy,
  lookupProxyCountry,
  lookupDirectCountry,
  probeProxyTunnel,
  probeProxyHttps,
  classifyProxyError,
  networkTypeFromLookup,
  fetchUrlText,
  extractProxyStrings,
  extractProxyFromApi,
  invokeProxyRefresh,
  resolveTlsProfile,
  tlsConnectOptionsFromProfile,
  TLS_PROFILE_PRESETS,
};
