const assert = require('assert');
const net = require('net');
const { parseProxy, startAuthenticatedProxy, encodeSocksAddress } = require('./proxy-forwarder');

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

const isMutate = process.argv.includes('--mutate');

(async () => {
  // 1. Dual-mode upstream SOCKS5 server:
  // If client offers 0x00, it selects 0x00, but fails CONNECT because auth was not performed.
  // If client offers 0x02, it authenticates with user/pass and succeeds.
  let dualModeAuthCount = 0;
  let boundaryAuthCount = 0;

  const targetEchoServer = net.createServer((socket) => {
    socket.on('data', (chunk) => socket.write(chunk));
    socket.on('error', () => {});
  });
  const echoPort = await listen(targetEchoServer);

  // Upstream server supporting dual-mode, special credentials with '#', and 255-byte boundary credentials
  const upstreamDual = net.createServer((socket) => {
    socket.on('error', () => {});
    const reader = new Reader(socket);
    (async () => {
      const greeting = await reader.read(2);
      const methods = await reader.read(greeting[1]);
      if (methods.includes(0)) {
        socket.write(Buffer.from([5, 0])); // No auth selected
        const req = await reader.read(4);
        socket.write(Buffer.from([5, 2, 0, 1, 0, 0, 0, 0, 0, 0])); // Rejection: connection not allowed
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

        // Check credentials: standard test credentials or 255-byte boundary credentials
        const isStandard = user === 'testuser' && pass === 'p#ss@word123';
        const isBoundary = user.length === 255 && pass.length === 255 && user.startsWith('u') && pass.startsWith('p#');

        if (isStandard || isBoundary) {
          if (isStandard) dualModeAuthCount += 1;
          if (isBoundary) boundaryAuthCount += 1;
          socket.write(Buffer.from([1, 0])); // RFC 1929 Auth OK
        } else {
          socket.write(Buffer.from([1, 1])); // Auth failed
          socket.destroy();
          return;
        }

        // Read SOCKS5 CONNECT command
        const head = await reader.read(4);
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

  // Test with password containing # and special characters across all supported format syntaxes
  const formatsToTest = [
    `socks5://testuser:p%23ss%40word123@127.0.0.1:${upstreamPort}`,
    `socks5://testuser:p#ss@word123@127.0.0.1:${upstreamPort}#my-remark`,
    `127.0.0.1:${upstreamPort}:testuser:p#ss@word123`,
    `127.0.0.1:${upstreamPort}@testuser:p#ss@word123`,
    `socks5://127.0.0.1:${upstreamPort}:testuser:p#ss@word123`,
    `testuser:12345@127.0.0.1:${upstreamPort}#my-num-remark`,
    `testuser:12345@127.0.0.1:${upstreamPort}`,
  ];

  for (const proxyUrl of formatsToTest) {
    const config = parseProxy(proxyUrl);
    assert.strictEqual(config.authenticated, true);
    assert.strictEqual(config.username, 'testuser');
    if (proxyUrl.includes(':12345@')) {
      assert.strictEqual(config.password, '12345');
      if (proxyUrl.includes('#my-num-remark')) {
        assert.strictEqual(config.remark, 'my-num-remark');
      }
    } else {
      assert.strictEqual(config.password, 'p#ss@word123');
      if (proxyUrl.includes('#my-remark')) {
        assert.strictEqual(config.remark, 'my-remark');
      }
    }
  }

  const primaryConfig = parseProxy(`socks5://testuser:p%23ss%40word123@127.0.0.1:${upstreamPort}#node-primary`);
  const bridge = await startAuthenticatedProxy(primaryConfig);
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

  // Test 2: Full Concurrency 128 connections without stall
  const concurrentCount = 128;
  const startTs = Date.now();
  const tasks = Array.from({ length: concurrentCount }).map(async (_, idx) => {
    const sock = await connect(bridge.port);
    sock.write(`CONNECT 127.0.0.1:${echoPort} HTTP/1.1\r\nHost: 127.0.0.1:${echoPort}\r\n\r\n`);
    const head = await until(sock, Buffer.from('\r\n\r\n'));
    assert(head.toString('latin1').includes('200 Connection Established'), `Tunnel ${idx} established`);
    sock.write(`concur-msg-${idx}`);
    const echo = await until(sock, Buffer.from(`concur-msg-${idx}`));
    assert(echo.includes(Buffer.from(`concur-msg-${idx}`)), `Echo ${idx} received`);
    sock.destroy();
  });
  await Promise.all(tasks);
  const duration = Date.now() - startTs;
  assert(duration < 8000, `Concurrent 128 took ${duration}ms, must be < 8000ms`);

  // Test 3: Relative HTTP GET request with Host header
  const clientHttp = await connect(bridge.port);
  clientHttp.write(`GET /hello-path HTTP/1.1\r\nHost: 127.0.0.1:${echoPort}\r\nConnection: close\r\n\r\n`);
  const respHttp = await until(clientHttp, Buffer.from('\r\n\r\n'));
  assert(respHttp.toString('latin1').includes('GET /hello-path HTTP/1.1'), 'Relative HTTP request forwarded properly');
  clientHttp.destroy();

  // Test 4: Destination host types: Domain and IPv6 targets through tunnel
  const clientDomain = await connect(bridge.port);
  clientDomain.write(`CONNECT localhost:${echoPort} HTTP/1.1\r\nHost: localhost:${echoPort}\r\n\r\n`);
  const respDomain = await until(clientDomain, Buffer.from('\r\n\r\n'));
  assert(respDomain.toString('latin1').includes('200 Connection Established'), 'Domain target tunnel established');
  clientDomain.write('ping-domain');
  const pongDomain = await until(clientDomain, Buffer.from('ping-domain'));
  assert(pongDomain.includes(Buffer.from('ping-domain')));
  clientDomain.destroy();

  // Test 5: RFC 1929 255-byte boundary username and password
  const maxUser = 'u'.repeat(255);
  const maxPass = 'p#' + 'x'.repeat(253); // Exactly 255 bytes with #
  assert.strictEqual(Buffer.byteLength(maxUser, 'utf8'), 255);
  assert.strictEqual(Buffer.byteLength(maxPass, 'utf8'), 255);
  const boundaryConfig = parseProxy({
    protocol: 'socks5',
    host: '127.0.0.1',
    port: upstreamPort,
    username: maxUser,
    password: maxPass,
  });
  const boundaryBridge = await startAuthenticatedProxy(boundaryConfig);
  const clientBoundary = await connect(boundaryBridge.port);
  clientBoundary.write(`CONNECT 127.0.0.1:${echoPort} HTTP/1.1\r\nHost: 127.0.0.1:${echoPort}\r\n\r\n`);
  const respBoundary = await until(clientBoundary, Buffer.from('\r\n\r\n'));
  assert(respBoundary.toString('latin1').includes('200 Connection Established'), 'Boundary credentials tunnel established');
  clientBoundary.destroy();
  await boundaryBridge.close();
  assert.strictEqual(boundaryAuthCount, 1, '255-byte boundary credentials authenticated successfully');

  // Test 6: Rejection of credentials exceeding RFC 1929 255-byte limit
  assert.throws(() => parseProxy({
    protocol: 'socks5',
    host: '127.0.0.1',
    port: 1080,
    username: 'u'.repeat(256),
    password: 'p',
  }));

  // Test 7: Clean bridge closing with no unhandled exceptions
  await bridge.close();

  // Mutation tests if --mutate is enabled
  if (isMutate) {
    // Mutation 1: Wrong password fails authentication and returns HTTP 502
    const wrongPassConfig = parseProxy(`socks5://testuser:wrongpassword@127.0.0.1:${upstreamPort}`);
    const wrongBridge = await startAuthenticatedProxy(wrongPassConfig);
    const clientWrong = await connect(wrongBridge.port);
    clientWrong.write(`CONNECT 127.0.0.1:${echoPort} HTTP/1.1\r\nHost: 127.0.0.1:${echoPort}\r\n\r\n`);
    const respWrong = await until(clientWrong, Buffer.from('\r\n\r\n'));
    assert(respWrong.toString('latin1').includes('502 Bad Gateway'), 'Wrong credentials rejected with 502');
    clientWrong.destroy();
    await wrongBridge.close();

    // Mutation 2: Invalid port rejected
    const testBridge = await startAuthenticatedProxy(primaryConfig);
    const clientBadPort = await connect(testBridge.port);
    clientBadPort.write(`CONNECT 127.0.0.1:0 HTTP/1.1\r\nHost: 127.0.0.1:0\r\n\r\n`);
    const respBadPort = await until(clientBadPort, Buffer.from('\r\n\r\n'));
    assert(respBadPort.toString('latin1').includes('502 Bad Gateway'), 'Port 0 rejected with 502');
    clientBadPort.destroy();
    await testBridge.close();
  }

  await new Promise((resolve) => upstreamDual.close(resolve));
  await new Promise((resolve) => targetEchoServer.close(resolve));

  console.log('SOCKS5_AUTH_COMPLETE_SELFTEST_OK dual_mode=1 special_credentials=1 concurrency=128 boundary_255=1 relative_http=1 domain_target=1' + (isMutate ? ' mutate=1' : ''));
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
