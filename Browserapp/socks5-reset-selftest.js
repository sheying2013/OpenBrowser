const assert = require('assert');
const net = require('net');
const { parseProxy, startAuthenticatedProxy } = require('./proxy-forwarder');

class Reader {
  constructor(socket) { this.buffer = Buffer.alloc(0); this.queue = []; socket.on('data', (chunk) => { this.buffer = Buffer.concat([this.buffer, chunk]); this.pump(); }); socket.on('error', () => {}); }
  read(size) { return new Promise((resolve) => { this.queue.push({ size, resolve }); this.pump(); }); }
  pump() { const item = this.queue[0]; if (!item || this.buffer.length < item.size) return; this.queue.shift(); const value = this.buffer.subarray(0, item.size); this.buffer = this.buffer.subarray(item.size); item.resolve(value); }
}

function listen(server) { return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port))); }
function connect(port) { return new Promise((resolve, reject) => { const socket = net.connect({ host: '127.0.0.1', port }, () => resolve(socket)); socket.once('error', reject); }); }
function until(socket, marker) { return new Promise((resolve) => { let value = Buffer.alloc(0); const onData = (chunk) => { value = Buffer.concat([value, chunk]); if (value.includes(marker)) { socket.off('data', onData); resolve(value); } }; socket.on('data', onData); }); }

async function run() {
  let authenticated = false; let tunnelRequested = false; let uncaught = null;
  const onUncaught = (error) => { uncaught = error; };
  process.once('uncaughtException', onUncaught);
  const upstreamServer = net.createServer((socket) => {
    socket.on('error', () => {});
    const reader = new Reader(socket);
    (async () => {
      const greeting = await reader.read(2); await reader.read(greeting[1]); socket.write(Buffer.from([5, 2]));
      const authHead = await reader.read(2); const user = await reader.read(authHead[1]); const passSize = await reader.read(1); const password = await reader.read(passSize[0]);
      authenticated = user.toString() === 'user' && password.toString() === 'pass'; socket.write(Buffer.from([1, 0]));
      const request = await reader.read(5); await reader.read(request[4]); await reader.read(2); tunnelRequested = request[1] === 1;
      socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 80]));
      await reader.read(4);
      if (typeof socket.resetAndDestroy === 'function') socket.resetAndDestroy(); else socket.destroy();
    })().catch(() => socket.destroy());
  });
  const upstreamPort = await listen(upstreamServer);
  const bridge = await startAuthenticatedProxy(parseProxy('socks5://user:pass@127.0.0.1:' + upstreamPort));
  const client = await connect(bridge.port); client.on('error', () => {});
  client.write('CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n');
  const reply = await until(client, Buffer.from('\r\n\r\n')); assert(reply.toString('latin1').startsWith('HTTP/1.1 200')); client.write('PING');
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert(authenticated && tunnelRequested);
  assert.strictEqual(uncaught, null);
  client.destroy(); await bridge.close(); await new Promise((resolve) => upstreamServer.close(resolve));
  process.removeListener('uncaughtException', onUncaught);
  console.log('SOCKS5_RESET_SELFTEST_OK auth=1 tunnel=1 upstream_reset_handled=1 uncaught=0');
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
