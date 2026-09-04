const assert = require('assert');
const net = require('net');
const {
  parseProxy,
  parseProxyInput,
  displayProxy,
  startAuthenticatedProxy,
  normalizeIpLookupChannel,
  normalizeIfconfigMeResult,
  encodeSocksAddress,
} = require('./proxy-forwarder');

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
  const ipv6Target = encodeSocksAddress('2001:db8::1');
  assert.strictEqual(ipv6Target[0], 4);
  assert.strictEqual(ipv6Target.length, 17);
  assert.deepStrictEqual([...ipv6Target.slice(1)], [0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
  assert.strictEqual(encodeSocksAddress('[::ffff:192.0.2.1]')[0], 4);

  const vendor = parseProxy('socks5://fa8a524c:2c1f8c80\\@192.168.1.22:31055#🇪🇸isp马德里-1');
  assert.strictEqual(vendor.username, 'fa8a524c');
  assert.strictEqual(vendor.password, '2c1f8c80');
  assert.strictEqual(vendor.host, '192.168.1.22');
  assert.strictEqual(vendor.remark, '🇪🇸isp马德里-1');
  assert.strictEqual(vendor.name, '🇪🇸isp马德里-1');
  assert.strictEqual(vendor.chromeUrl, 'socks5://192.168.1.22:31055');
  assert.ok(vendor.raw.endsWith('#' + encodeURIComponent('🇪🇸isp马德里-1')));

  const rawSpecial = parseProxy('socks5://用@户:密@码:/100%\\目录@proxy.test:1080#东京节点');
  assert.strictEqual(rawSpecial.username, '用@户');
  assert.strictEqual(rawSpecial.password, '密@码:/100%\\目录');
  assert.strictEqual(rawSpecial.remark, '东京节点');
  const rawSpecialRoundTrip = parseProxy(rawSpecial.raw);
  assert.strictEqual(rawSpecialRoundTrip.username, rawSpecial.username);
  assert.strictEqual(rawSpecialRoundTrip.password, rawSpecial.password);
  assert.strictEqual(rawSpecialRoundTrip.remark, rawSpecial.remark);

  const structured = parseProxyInput({
    protocol: 'https',
    host: 'proxy.test',
    port: 8443,
    username: '用@户:名/%\\',
    password: '密@码:/%\\尾',
    remark: '东京 #1',
  });
  assert.strictEqual(structured.username, '用@户:名/%\\');
  assert.strictEqual(structured.password, '密@码:/%\\尾');
  assert.strictEqual(structured.remark, '东京 #1');
  assert.strictEqual(structured.chromeUrl, 'https://proxy.test:8443');
  assert.strictEqual(parseProxy(structured.raw).password, structured.password);
  const mixedInput = parseProxyInput({
    raw: 'http://mixed.test:8080#raw-note',
    username: 'mixed@user',
    password: 'mixed:/%\\pass',
    remark: 'field-note',
  });
  assert.strictEqual(mixedInput.username, 'mixed@user');
  assert.strictEqual(mixedInput.password, 'mixed:/%\\pass');
  assert.strictEqual(mixedInput.remark, 'field-note');
  assert.strictEqual(parseProxy(mixedInput.raw).password, mixedInput.password);
  assert.throws(() => parseProxy('bad-format'));
  assert.strictEqual(normalizeIpLookupChannel('ifconfig.me'), 'ifconfig-me');
  assert.strictEqual(normalizeIpLookupChannel('unknown-provider'), 'ip-api');
  assert.strictEqual(normalizeIfconfigMeResult('203.0.113.8\n').ip, '203.0.113.8');
  assert.strictEqual(normalizeIfconfigMeResult('2001:db8::8').source, 'ifconfig.me');
  assert.throws(() => normalizeIfconfigMeResult('<html>not an IP</html>'));

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
  console.log('PROXY_FORWARDER_SELFTEST_OK formats=8 escaped_separator=1 special_credentials=1 mixed_input=1 remark=1 ipv6_target=1 ifconfig_ip=1 auth_header=1 connect_tunnel=1 echo=1 credentials_masked=1');
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
