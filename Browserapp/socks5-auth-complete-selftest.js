const assert = require('assert');
const net = require('net');
const http = require('http');
const { parseProxy, startAuthenticatedProxy } = require('./proxy-forwarder');

class Reader {
  constructor(socket) {
    this.buffer = Buffer.alloc(0);
    this.queue = [];
    socket.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.pump();
    });
    socket.on('error', () => {});
  }
  read(size) {
    return new Promise((resolve) => {
      this.queue.push({ size, resolve });
      this.pump();
    });
  }
  pump() {
    const item = this.queue[0];
    if (!item || this.buffer.length < item.size) return;
    this.queue.shift();
    const value = this.buffer.subarray(0, item.size);
    this.buffer = this.buffer.subarray(item.size);
    item.resolve(value);
  }
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function connect(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => resolve(socket));
    socket.once('error', reject);
  });
}

function until(socket, marker) {
  return new Promise((resolve, reject) => {
    let value = Buffer.alloc(0);
    const onData = (chunk) => {
      value = Buffer.concat([value, chunk]);
      if (value.includes(marker)) {
        socket.off('data', onData);
        socket.off('error', onError);
        resolve(value);
      }
    };
    const onError = (error) => {
      socket.off('data', onData);
      socket.off('error', onError);
      reject(error);
    };
    socket.on('data', onData);
    socket.once('error', onError);
  });
}

(async () => {
  // 1. Dual-mode upstream SOCKS5 server:
  // If client offers 0x00, it selects 0x00, but fails CONNECT because auth was not performed.
  // If client offers 0x02, it authenticates with user/pass and succeeds!
  let dualModeAuthCount = 0;
  const targetEchoServer = net.createServer((socket) => {
    socket.on('data', (chunk) => socket.write(chunk));
    socket.on('error', () => {});
  });
  const echoPort = await listen(targetEchoServer);

  const upstreamDual = net.createServer((socket) => {
    socket.on('error', () => {});
    const reader = new Reader(socket);
    (async () => {
      const greeting = await reader.read(2);
      const methods = await reader.read(greeting[1]);
      // If 0x00 is in methods, this server prefers 0x00 (the bug that broke dual-mode proxies)
      if (methods.includes(0)) {
        socket.write(Buffer.from([5, 0])); // No auth selected
        // Later when CONNECT arrives:
        const req = await reader.read(4);
        // Server rejects unauthenticated CONNECT with 0x02 (connection not allowed by ruleset)
        socket.write(Buffer.from([5, 2, 0, 1, 0, 0, 0, 0, 0, 0]));
        socket.destroy();
        return;
      }
      if (methods.includes(2)) {
        socket.write(Buffer.from([5, 2])); // Require user/pass
        const authHead = await reader.read(2);
        const ulen = authHead[1];
        const user = (await reader.read(ulen)).toString('utf8');
        const plenBuf = await reader.read(1);
        const plen = plenBuf[0];
        const pass = (await reader.read(plen)).toString('utf8');
        if (user === 'testuser' && pass === 'p#ss@word123') {
          dualModeAuthCount += 1;
          socket.write(Buffer.from([1, 0])); // Auth OK
        } else {
          socket.write(Buffer.from([1, 1])); // Auth failed
          socket.destroy();
          return;
        }
        // Read CONNECT
        const head = await reader.read(4);
        let addr = '';
        if (head[3] === 1) await reader.read(4);
        else if (head[3] === 3) {
          const s = await reader.read(1);
          await reader.read(s[0]);
        } else if (head[3] === 4) await reader.read(16);
        await reader.read(2);

        // Connect to echo server
        const target = net.connect({ host: '127.0.0.1', port: echoPort }, () => {
          socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 80]));
          socket.pipe(target);
          target.pipe(socket);
        });
        target.on('error', () => socket.destroy());
      } else {
        socket.write(Buffer.from([5, 255]));
        socket.destroy();
      }
    })().catch(() => socket.destroy());
  });
  const upstreamPort = await listen(upstreamDual);

  // Test with password containing # and special characters
  const proxyUrl = `socks5://testuser:p%23ss%40word123@127.0.0.1:${upstreamPort}`;
  const config = parseProxy(proxyUrl);
  assert.strictEqual(config.authenticated, true);
  assert.strictEqual(config.username, 'testuser');
  assert.strictEqual(config.password, 'p#ss@word123');

  const bridge = await startAuthenticatedProxy(config);
  assert.strictEqual(bridge.protocol, 'http');

  // Test 1: CONNECT tunnel
  const client1 = await connect(bridge.port);
  client1.write(`CONNECT 127.0.0.1:${echoPort} HTTP/1.1\r\nHost: 127.0.0.1:${echoPort}\r\n\r\n`);
  const resp1 = await until(client1, Buffer.from('\r\n\r\n'));
  assert(resp1.toString('latin1').includes('200 Connection Established'), 'Tunnel established');
  client1.write('ping-dual-mode');
  const pong1 = await until(client1, Buffer.from('ping-dual-mode'));
  assert(pong1.includes(Buffer.from('ping-dual-mode')));
  client1.destroy();
  assert(dualModeAuthCount >= 1, 'Dual-mode SOCKS5 authenticated successfully');

  // Test 2: Concurrent connections (16 concurrent) without stall
  const concurrentCount = 16;
  const startTs = Date.now();
  const tasks = Array.from({ length: concurrentCount }).map(async (_, idx) => {
    const sock = await connect(bridge.port);
    sock.write(`CONNECT 127.0.0.1:${echoPort} HTTP/1.1\r\nHost: 127.0.0.1:${echoPort}\r\n\r\n`);
    const head = await until(sock, Buffer.from('\r\n\r\n'));
    assert(head.toString('latin1').includes('200 Connection Established'));
    sock.write(`concur-msg-${idx}`);
    const echo = await until(sock, Buffer.from(`concur-msg-${idx}`));
    assert(echo.includes(Buffer.from(`concur-msg-${idx}`)));
    sock.destroy();
  });
  await Promise.all(tasks);
  const duration = Date.now() - startTs;
  assert(duration < 3000, `Concurrent 16 took ${duration}ms, must be < 3000ms`);

  // Test 3: Relative HTTP GET request with Host header
  const clientHttp = await connect(bridge.port);
  clientHttp.write(`GET /hello-path HTTP/1.1\r\nHost: 127.0.0.1:${echoPort}\r\nConnection: close\r\n\r\n`);
  const respHttp = await until(clientHttp, Buffer.from('\r\n\r\n'));
  assert(respHttp.toString('latin1').includes('GET /hello-path HTTP/1.1'), 'Relative HTTP request forwarded properly');
  clientHttp.destroy();

  await bridge.close();
  await new Promise((resolve) => upstreamDual.close(resolve));
  await new Promise((resolve) => targetEchoServer.close(resolve));

  console.log('SOCKS5_AUTH_COMPLETE_SELFTEST_OK dual_mode=1 special_chars=1 concurrency=16 relative_http=1');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
