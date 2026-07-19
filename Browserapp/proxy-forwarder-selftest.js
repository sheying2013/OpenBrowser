const assert = require('assert');
const net = require('net');
const { parseProxy, displayProxy, startAuthenticatedProxy } = require('./proxy-forwarder');

function listen(server) {
  return new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(server.address().port)); });
}

function connect(port) {
  return new Promise((resolve, reject) => { const socket = net.connect({ host: '127.0.0.1', port }, () => resolve(socket)); socket.once('error', reject); });
}

function until(socket, marker) {
  return new Promise((resolve, reject) => {
    let data = Buffer.alloc(0);
    const onData = (chunk) => { data = Buffer.concat([data, chunk]); if (data.includes(marker)) { cleanup(); resolve(data); } };
    const onError = (error) => { cleanup(); reject(error); };
    const cleanup = () => { socket.off('data', onData); socket.off('error', onError); };
    socket.on('data', onData); socket.once('error', onError);
  });
}

async function run() {
  const config = parseProxy('127.0.0.1:1234:test-user:test-password');
  assert.strictEqual(config.authenticated, true);
  assert.strictEqual(config.protocol, 'socks5');
  assert.strictEqual(config.host, '127.0.0.1');
  assert.strictEqual(config.port, 1234);
  assert.strictEqual(displayProxy(config.raw), 'SOCKS5 · 127.0.0.1:1234 · Auth');
  const socks = parseProxy('socks5://test-user:test-password@127.0.0.1:1080');
  assert.strictEqual(socks.protocol, 'socks5');
  assert.strictEqual(socks.authenticated, true);
  assert.strictEqual(parseProxy('socks5://127.0.0.1:1080').chromeUrl, 'socks5://127.0.0.1:1080');
  assert.throws(() => parseProxy('bad-format'));

  let receivedHeader = '';
  const upstream = net.createServer((socket) => {
    let input = Buffer.alloc(0);
    const first = (chunk) => {
      input = Buffer.concat([input, chunk]); const marker = input.indexOf('\r\n\r\n'); if (marker < 0) return;
      socket.off('data', first); receivedHeader = input.subarray(0, marker + 4).toString('latin1');
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      socket.on('data', (data) => socket.write(data));
      const remainder = input.subarray(marker + 4); if (remainder.length) socket.write(remainder);
    };
    socket.on('data', first);
  });
  const upstreamPort = await listen(upstream);
  const runtimeConfig = parseProxy('http://test-user:test-password@127.0.0.1:' + upstreamPort);
  const forwarder = await startAuthenticatedProxy(runtimeConfig);
  const client = await connect(forwarder.port);
  client.write('CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n');
  const response = await until(client, Buffer.from('\r\n\r\n'));
  assert(response.toString('latin1').startsWith('HTTP/1.1 200'));
  assert(receivedHeader.includes('Proxy-Authorization: Basic ' + Buffer.from('test-user:test-password').toString('base64')));
  client.write('PING');
  const echoed = await until(client, Buffer.from('PING'));
  assert(echoed.includes(Buffer.from('PING')));
  client.destroy(); await forwarder.close(); await new Promise((resolve) => upstream.close(resolve));
  console.log('PROXY_FORWARDER_SELFTEST_OK formats=4 auth_header=1 connect_tunnel=1 echo=1 credentials_masked=1');
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
