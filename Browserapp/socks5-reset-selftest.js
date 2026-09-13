const assert = require('assert');
const net = require('net');
const { parseProxy, startAuthenticatedProxy, startSocks5Bridge } = require('./proxy-forwarder');

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
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function connect(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => resolve(socket));
    socket.once('error', reject);
  });
}

function until(socket, marker) {
  return new Promise((resolve) => {
    let value = Buffer.alloc(0);
    const onData = (chunk) => {
      value = Buffer.concat([value, chunk]);
      if (value.includes(marker)) {
        socket.off('data', onData);
        resolve(value);
      }
    };
    socket.on('data', onData);
  });
}

const isMutate = process.argv.includes('--mutate');

async function run() {
  let uncaught = null;
  const onUncaught = (error) => { uncaught = error; };
  process.on('uncaughtException', onUncaught);

  // Phase 1: Reset during initial greeting handshake
  let greetingResetHandled = false;
  const serverGreetingReset = net.createServer((socket) => {
    socket.on('error', () => {});
    socket.destroy(); // Immediate abrupt reset on connect
  });
  const portGreetingReset = await listen(serverGreetingReset);
  const bridge1 = await startAuthenticatedProxy(parseProxy('socks5://user:pass@127.0.0.1:' + portGreetingReset));
  const client1 = await connect(bridge1.port); client1.on('error', () => {});
  client1.write('CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n');
  const reply1 = await until(client1, Buffer.from('\r\n\r\n'));
  assert(reply1.toString('latin1').includes('502 Bad Gateway'), 'Greeting reset returns 502');
  client1.destroy();
  await bridge1.close();
  await new Promise((resolve) => serverGreetingReset.close(resolve));
  greetingResetHandled = true;

  // Phase 2: Reset during RFC 1929 authentication
  let authResetHandled = false;
  const serverAuthReset = net.createServer((socket) => {
    socket.on('error', () => {});
    const reader = new Reader(socket);
    (async () => {
      const greeting = await reader.read(2);
      await reader.read(greeting[1]);
      socket.write(Buffer.from([5, 2])); // Request user/pass
      const authHead = await reader.read(2);
      await reader.read(authHead[1]);
      const passSize = await reader.read(1);
      await reader.read(passSize[0]);
      // Reset abruptly instead of sending auth reply
      if (typeof socket.resetAndDestroy === 'function') socket.resetAndDestroy(); else socket.destroy();
    })().catch(() => socket.destroy());
  });
  const portAuthReset = await listen(serverAuthReset);
  const bridge2 = await startAuthenticatedProxy(parseProxy('socks5://user:pass@127.0.0.1:' + portAuthReset));
  const client2 = await connect(bridge2.port); client2.on('error', () => {});
  client2.write('CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n');
  const reply2 = await until(client2, Buffer.from('\r\n\r\n'));
  assert(reply2.toString('latin1').includes('502 Bad Gateway'), 'Auth reset returns 502');
  client2.destroy();
  await bridge2.close();
  await new Promise((resolve) => serverAuthReset.close(resolve));
  authResetHandled = true;

  // Phase 3: Reset during SOCKS5 CONNECT command
  let connectResetHandled = false;
  const serverConnectReset = net.createServer((socket) => {
    socket.on('error', () => {});
    const reader = new Reader(socket);
    (async () => {
      const greeting = await reader.read(2);
      await reader.read(greeting[1]);
      socket.write(Buffer.from([5, 2]));
      const authHead = await reader.read(2);
      await reader.read(authHead[1]);
      const passSize = await reader.read(1);
      await reader.read(passSize[0]);
      socket.write(Buffer.from([1, 0])); // Auth OK
      await reader.read(4); // Read CONNECT head
      // Reset abruptly before sending CONNECT reply
      if (typeof socket.resetAndDestroy === 'function') socket.resetAndDestroy(); else socket.destroy();
    })().catch(() => socket.destroy());
  });
  const portConnectReset = await listen(serverConnectReset);
  const bridge3 = await startAuthenticatedProxy(parseProxy('socks5://user:pass@127.0.0.1:' + portConnectReset));
  const client3 = await connect(bridge3.port); client3.on('error', () => {});
  client3.write('CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n');
  const reply3 = await until(client3, Buffer.from('\r\n\r\n'));
  assert(reply3.toString('latin1').includes('502 Bad Gateway'), 'CONNECT reset returns 502');
  client3.destroy();
  await bridge3.close();
  await new Promise((resolve) => serverConnectReset.close(resolve));
  connectResetHandled = true;

  // Phase 4: Reset during active tunnel data streaming
  let authenticated = false;
  let tunnelRequested = false;
  const upstreamServer = net.createServer((socket) => {
    socket.on('error', () => {});
    const reader = new Reader(socket);
    (async () => {
      const greeting = await reader.read(2);
      await reader.read(greeting[1]);
      socket.write(Buffer.from([5, 2]));
      const authHead = await reader.read(2);
      const user = await reader.read(authHead[1]);
      const passSize = await reader.read(1);
      const password = await reader.read(passSize[0]);
      authenticated = user.toString() === 'user' && password.toString() === 'pass';
      socket.write(Buffer.from([1, 0]));
      const request = await reader.read(5);
      await reader.read(request[4]);
      await reader.read(2);
      tunnelRequested = request[1] === 1;
      socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 80]));
      await reader.read(4); // Read PING
      if (typeof socket.resetAndDestroy === 'function') socket.resetAndDestroy(); else socket.destroy();
    })().catch(() => socket.destroy());
  });
  const upstreamPort = await listen(upstreamServer);
  const bridge = await startAuthenticatedProxy(parseProxy('socks5://user:pass@127.0.0.1:' + upstreamPort));
  const client = await connect(bridge.port); client.on('error', () => {});
  client.write('CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n');
  const reply = await until(client, Buffer.from('\r\n\r\n'));
  assert(reply.toString('latin1').startsWith('HTTP/1.1 200'));
  client.write('PING');
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert(authenticated && tunnelRequested);
  assert.strictEqual(uncaught, null, 'No uncaught exceptions during active tunnel reset');
  client.destroy();
  await bridge.close();
  await new Promise((resolve) => upstreamServer.close(resolve));

  // Phase 5: Reset / error during startSocks5Bridge upstream handshake
  let socks5BridgeUpstreamDestroyed = false;
  const serverSocks5BridgeReset = net.createServer((socket) => {
    socket.on("error", () => {});
    socket.once("data", () => {
      socket.destroy(); // Abrupt reset during upstream greeting
    });
    socket.once("close", () => { socks5BridgeUpstreamDestroyed = true; });
  });
  const portSocks5BridgeReset = await listen(serverSocks5BridgeReset);
  const bridgeSocks5 = await startSocks5Bridge(parseProxy("socks5://127.0.0.1:" + portSocks5BridgeReset));
  const clientSocks5 = await connect(bridgeSocks5.port); clientSocks5.on("error", () => {});
  clientSocks5.write(Buffer.from([5, 1, 0])); // greeting
  await until(clientSocks5, Buffer.from([5, 0]));
  clientSocks5.write(Buffer.from([5, 1, 0, 1, 127, 0, 0, 1, 0, 80])); // connect
  const replySocks5 = await until(clientSocks5, Buffer.from([5, 1, 0, 1, 0, 0, 0, 0, 0, 0]));
  assert.strictEqual(replySocks5[1], 1, "Bridge returns general SOCKS server failure (0x01) on upstream reset");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(socks5BridgeUpstreamDestroyed, "startSocks5Bridge upstream socket must be destroyed on upstream reset");
  clientSocks5.destroy();
  await bridgeSocks5.close();
  await new Promise((resolve) => serverSocks5BridgeReset.close(resolve));

  process.removeListener('uncaughtException', onUncaught);

  assert.ok(greetingResetHandled && authResetHandled && connectResetHandled);
  console.log('SOCKS5_RESET_SELFTEST_OK auth=1 tunnel=1 upstream_reset_handled=1 uncaught=0' + (isMutate ? ' mutate=1' : ''));
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
