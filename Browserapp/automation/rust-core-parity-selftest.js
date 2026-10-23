'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { execFileSync } = require('node:child_process');
const { Reader, connect, listen, socksServer } = require('./rust-core-test-fixtures');
const core = require('./rust-core-bridge');
const { startAuthenticatedProxy } = require('../proxy-forwarder');

async function check(name, action) { await action(); console.log('PASS ' + name); }
async function request(port, target, route) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: route,
      headers: { Host: '127.0.0.1:' + target, 'Proxy-Authorization': 'Basic local-only', 'Proxy-Connection': 'close', Connection: 'close' } }, res => {
      let body = ''; res.setEncoding('utf8'); res.on('data', data => { body += data; });
      res.on('end', () => resolve({ status: res.statusCode, body })); res.on('error', reject);
    });
    req.setTimeout(3000, () => req.destroy(new Error('HTTP parity deadline'))); req.on('error', reject); req.end();
  });
}

(async () => {
  await check('versioned capabilities and honest offline TLS boundary', async () => {
    const version = core.getRustCoreVersion();
    assert.equal(version.name, 'openbrowser-core'); assert.equal(version.control_protocol, 1);
    assert(version.capabilities.includes('socks5-upstream')); assert(!version.capabilities.includes('https-upstream'));
    const tls = core.getRustTlsProfile('probe.test'); assert.equal(tls.transport_integrated, false); assert.equal(tls.experimental, true);
  });
  await check('zero options and disjoint Rust layout plans', async () => {
    assert.equal(core.calculateRustTileGrid({ count: 0, taskbarHeight: 0, margin: 0, gap: 0 }).windows.length, 0);
    const result = core.calculateRustTileGrid({ count: 6, taskbarHeight: 0, margin: 0, gap: 0 });
    assert.equal(result.windows.length, 6); assert.equal(result.screen.taskbar, 0);
    for (let i = 0; i < result.windows.length; i++) for (let j = i + 1; j < result.windows.length; j++) {
      const a = result.windows[i], b = result.windows[j];
      assert(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y);
    }
    assert.throws(() => core.calculateRustTileGrid({ count: -1 }));
  });
  await check('absolute and relative HTTP reach the actual destination through Rust SOCKS5', async () => {
    const origin = http.createServer((req, res) => { res.setHeader('Connection', 'close'); res.end(JSON.stringify({ url: req.url, auth: req.headers['proxy-authorization'] ?? null })); });
    const originSockets = new Set(); origin.on('connection', socket => { originSockets.add(socket); socket.on('close', () => originSockets.delete(socket)); });
    await new Promise(resolve => origin.listen(0, '127.0.0.1', resolve));
    const target = origin.address().port;
    const upstream = await socksServer(); let bridge;
    try {
      process.env.OPENBROWSER_USE_RUST_CORE = '1';
      bridge = await startAuthenticatedProxy({ protocol: 'socks5', host: '127.0.0.1', port: upstream.port });
      assert.equal(bridge.engine, 'rust-core');
      for (const route of ['http://127.0.0.1:' + target + '/absolute?q=1', '/relative']) {
        const result = await request(bridge.port, target, route);
        assert.equal(result.status, 200);
        const actual = JSON.parse(result.body);
        assert.equal(actual.url, route.startsWith('http:') ? '/absolute?q=1' : route);
        assert.equal(actual.auth, null);
      }
      assert.equal(upstream.targets.length, 2);
      assert(upstream.targets.every(value => value.host === '127.0.0.1' && value.port === target));
      assert.equal(upstream.errors.length, 0);
    } finally { await bridge?.close(); await upstream.close(); for (const socket of originSockets) socket.destroy(); await new Promise(resolve => origin.close(resolve)); }
  });
  await check('authenticated tunnel preserves initial bytes and closes exactly once without argv secrets', async () => {
    const echo = await listen(socket => socket.on('data', data => socket.write(data)));
    const upstream = await socksServer({ username: 'audit', password: 'synthetic-private-marker' }); let bridge, client;
    try {
      bridge = await core.startRustProxyBridge({ protocol: 'socks5', host: '127.0.0.1', port: upstream.port, username: 'audit', password: 'synthetic-private-marker' });
      if (process.platform !== 'win32') {
        const argv = execFileSync('ps', ['-p', String(bridge.pid), '-o', 'command='], { encoding: 'utf8' });
        assert(!argv.includes('synthetic-private-marker')); assert(!argv.includes('--config'));
      }
      client = await connect(bridge.port); const input = new Reader(client);
      client.write('CONNECT 127.0.0.1:' + echo.port + ' HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\nINITIAL_BINARY_PAYLOAD');
      assert.match((await input.read(Buffer.from('\r\n\r\n'))).toString(), /^HTTP\/1[.]1 200 /);
      assert.equal((await input.read(22)).toString(), 'INITIAL_BINARY_PAYLOAD');
      const stopped = bridge.stop(); assert.equal(stopped, bridge.stop());
      await Promise.all([stopped, bridge.stop()]);
      assert.notEqual(bridge.child.exitCode, null);
    } finally { client?.destroy(); await bridge?.stop(); await upstream.close(); await echo.close(); }
  });
  await check('HTTP upstream prefix is preserved and reason-phrase 200 is not accepted', async () => {
    for (const status of ['200 OK', '403 denied-200-marker']) {
      const upstream = await listen(async socket => {
        const input = new Reader(socket); await input.read(Buffer.from('\r\n\r\n'));
        socket.write('HTTP/1.1 ' + status + '\r\n\r\nSERVER_PREFIX');
      }); let bridge, client;
      try {
        bridge = await core.startRustProxyBridge({ protocol: 'http', host: '127.0.0.1', port: upstream.port });
        client = await connect(bridge.port); const input = new Reader(client);
        client.write('CONNECT local.test:443 HTTP/1.1\r\nHost: local.test\r\n\r\n');
        const head = (await input.read(Buffer.from('\r\n\r\n'))).toString();
        assert.match(head, status.startsWith('200') ? /^HTTP\/1[.]1 200 / : /^HTTP\/1[.]1 502 /);
        if (status.startsWith('200')) assert.equal((await input.read(13)).toString(), 'SERVER_PREFIX');
      } finally { client?.destroy(); await bridge?.stop(); await upstream.close(); }
    }
  });
  await check('HTTPS upstream stays on existing JS TLS implementation', async () => {
    process.env.OPENBROWSER_USE_RUST_CORE = '1';
    const bridge = await startAuthenticatedProxy({ protocol: 'https', host: '127.0.0.1', port: 9 });
    try { assert.notEqual(bridge.engine, 'rust-core'); } finally { await bridge.close(); }
  });
  await check('Rust failure status and cancelled startup preserve the existing contract', async () => {
    const upstream = await listen(async socket => {
      const input = new Reader(socket); await input.read(Buffer.from('\r\n\r\n'));
      socket.end('HTTP/1.1 407 Authentication Required\r\n\r\n');
    }); let bridge, client; const events = [];
    try {
      bridge = await core.startRustProxyBridge({ protocol: 'http', host: '127.0.0.1', port: upstream.port,
        username: 'audit', password: 'status-private-marker' }, event => events.push(event));
      client = await connect(bridge.port); const input = new Reader(client);
      client.write('CONNECT local.test:443 HTTP/1.1\r\nHost: local.test\r\n\r\n');
      assert.match((await input.read(Buffer.from('\r\n\r\n'))).toString(), /502/);
      const until = Date.now() + 1000;
      while (!events.some(event => event.code === 'AUTH_FAILED') && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 5));
      assert(events.some(event => event.code === 'AUTH_FAILED'));
      assert(!JSON.stringify(events).includes('status-private-marker'));
    } finally { client?.destroy(); await bridge?.stop(); await upstream.close(); }
    const control = new AbortController(); control.abort();
    await assert.rejects(core.startRustProxyBridge({ protocol: 'socks5', host: '127.0.0.1', port: 9 }, () => {}, control.signal));
    await assert.rejects(core.startRustProxyBridge({ protocol: 'socks5', host: '', port: 0 }));
  });
  await check('probe orchestration retains the original JS backend', async () => {
    const signal = new AbortController().signal;
    const bridge = await startAuthenticatedProxy({ protocol: 'http', host: '127.0.0.1', port: 9, probeSignal: signal });
    try { assert.notEqual(bridge.engine, 'rust-core'); } finally { await bridge.close(); }
  });
  console.log('RUST_CORE_PARITY_SELFTEST_OK 8/8');
})().catch(error => { console.error(error); process.exitCode = 1; });
