const assert = require('assert');
const net = require('net');
const { parseProxy, startAuthenticatedProxy } = require('./proxy-forwarder');

class Reader {
  constructor(socket) { this.buffer = Buffer.alloc(0); this.queue = []; socket.on('data', (chunk) => { this.buffer = Buffer.concat([this.buffer, chunk]); this.pump(); }); socket.on('error', () => {}); }
  read(size) { return new Promise((resolve) => { this.queue.push({ size, resolve }); this.pump(); }); }
  pump() { const item = this.queue[0]; if (!item || this.buffer.length < item.size) return; this.queue.shift(); const value = this.buffer.subarray(0, item.size); this.buffer = this.buffer.subarray(item.size); item.resolve(value); }
}

function listen(server) { return new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(server.address().port)); }); }
function connect(port) { return new Promise((resolve, reject) => { const socket = net.connect({ host: '127.0.0.1', port }, () => resolve(socket)); socket.once('error', reject); }); }
function until(socket, marker) { return new Promise((resolve, reject) => { let value = Buffer.alloc(0); const onData = (chunk) => { value = Buffer.concat([value, chunk]); if (!value.includes(marker)) return; cleanup(); resolve(value); }; const onError = (error) => { cleanup(); reject(error); }; const cleanup = () => { socket.off('data', onData); socket.off('error', onError); }; socket.on('data', onData); socket.once('error', onError); }); }

(async () => {
  let connections = 0;
  const upstream = net.createServer((socket) => {
    connections += 1; socket.on('error', () => {});
    if (connections < 3) return socket.destroy();
    const reader = new Reader(socket);
    (async () => {
      const greeting = await reader.read(2); await reader.read(greeting[1]); socket.write(Buffer.from([5, 2]));
      const authHead = await reader.read(2); await reader.read(authHead[1]); const passSize = await reader.read(1); await reader.read(passSize[0]); socket.write(Buffer.from([1, 0]));
      const request = await reader.read(4); if (request[3] === 3) { const size = await reader.read(1); await reader.read(size[0]); } else if (request[3] === 1) await reader.read(4); else await reader.read(16); await reader.read(2);
      socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0x20, 0xfb]));
      const payload = await reader.read(8); socket.write(payload);
    })().catch(() => socket.destroy());
  });
  const upstreamPort = await listen(upstream);
  const bridge = await startAuthenticatedProxy(parseProxy('socks5://user:pass@127.0.0.1:' + upstreamPort));
  const client = await connect(bridge.port); client.on('error', () => {});
  client.write('CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n');
  const response = await until(client, Buffer.from('\r\n\r\n')); assert.match(response.toString('latin1'), /^HTTP\/1\.1 200/);
  client.write('retry-ok'); const echoed = await until(client, Buffer.from('retry-ok')); assert(echoed.includes(Buffer.from('retry-ok'))); assert.strictEqual(connections, 3);
  client.destroy(); await bridge.close(); await new Promise((resolve) => upstream.close(resolve));
  console.log('SOCKS5_RETRY_SELFTEST_OK attempts=3 tunnel=1 echo=1');
})().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
