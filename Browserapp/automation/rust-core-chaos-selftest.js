'use strict';
const assert = require('node:assert/strict');
const { once } = require('node:events');
const core = require('./rust-core-bridge');
const { Reader, connect, listen, socksServer } = require('./rust-core-test-fixtures');

function bounded(promise, ms, message) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })])
    .finally(() => clearTimeout(timer));
}
async function tunnel(bridge, target, clients) {
  const socket = await connect(bridge.port); clients.add(socket);
  socket.on('close', () => clients.delete(socket));
  const input = new Reader(socket);
  socket.write('CONNECT 127.0.0.1:' + target + ' HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
  assert.match((await input.read(Buffer.from('\r\n\r\n'))).toString(), /^HTTP\/1[.]1 200 /);
  return { socket, input };
}

(async () => {
  const upstream = await socksServer();
  const echo = await listen(socket => socket.on('data', data => socket.write(data)));
  const clients = new Set();
  const bridges = new Set();
  const start = async port => {
    const bridge = await core.startRustProxyBridge({ protocol: 'socks5', host: '127.0.0.1', port });
    bridges.add(bridge); return bridge;
  };
  try {
    for (let i = 0; i < 15; i++) {
      const bridge = await start(upstream.port); await bridge.stop();
      assert.equal(bridge.child.exitCode, 0); bridges.delete(bridge);
      await assert.rejects(connect(bridge.port), /ECONNREFUSED/);
    }
    console.log('PASS 15 start/stop cycles: actual exit and closed listener verified');

    const killed = await start(upstream.port);
    const active = await tunnel(killed, echo.port, clients);
    active.socket.write('payload-before-kill');
    assert.equal((await active.input.read(19)).toString(), 'payload-before-kill');
    const clientClosed = new Promise(resolve => active.socket.once('close', resolve));
    killed.child.kill('SIGKILL');
    await bounded(Promise.all([clientClosed, killed.done]), 2000, 'SIGKILL cleanup did not finish');
    assert.equal(killed.child.signalCode, 'SIGKILL'); await killed.stop(); bridges.delete(killed);
    console.log('PASS active payload transfer then SIGKILL: observed socket closure and process exit');

    const blackhole = await listen(socket => socket.on('data', () => {}));
    let blocked;
    try {
      blocked = await start(blackhole.port);
      const socket = await connect(blocked.port); clients.add(socket); socket.on('close', () => clients.delete(socket));
      const input = new Reader(socket); const began = Date.now();
      socket.write('CONNECT 127.0.0.1:1 HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
      const response = (await input.read(Buffer.from('\r\n\r\n'), 9500)).toString();
      assert.match(response, /^HTTP\/1[.]1 (408|502) /);
      assert(Date.now() - began < 9500); socket.destroy();
    } finally { await blocked?.stop(); if (blocked) bridges.delete(blocked); await blackhole.close(); }
    console.log('PASS silent upstream returns a timeout response within the handshake budget');

    const burst = await start(upstream.port);
    await Promise.all(Array.from({ length: 50 }, async (_, i) => {
      const { socket, input } = await tunnel(burst, echo.port, clients);
      const data = Buffer.from('burst-' + i); socket.write(data);
      assert.deepEqual(await input.read(data.length), data); socket.destroy();
    }));
    await burst.stop(); bridges.delete(burst);
    assert.equal(upstream.errors.length, 0);
    console.log('PASS 50 simultaneous connections reach the real echo origin with exact payloads');

    for (let count = 1; count <= 24; count++) {
      const { windows } = core.calculateRustTileGrid({ screenWidth: 2560, screenHeight: 1440, taskbarHeight: 48, count, margin: 10, gap: 10 });
      assert.equal(windows.length, count);
      for (const rect of windows) {
        assert(rect.width > 0 && rect.height > 0 && rect.x >= 10 && rect.y >= 10);
        assert(rect.x + rect.width <= 2550 && rect.y + rect.height <= 1382);
      }
      for (let i = 0; i < windows.length; i++) for (let j = i + 1; j < windows.length; j++) {
        const a = windows[i], b = windows[j];
        assert(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y);
      }
    }
    console.log('PASS 1..24 layouts: count, work-area bounds and pairwise non-overlap');
    console.log('RUST_CORE_CHAOS_SELFTEST_OK 5/5');
  } finally {
    for (const socket of clients) socket.destroy();
    await Promise.all([...bridges].map(bridge => bridge.stop()));
    await upstream.close(); await echo.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
